import { Deferred } from "./utils"

export interface Options {
  minResources: number
  maxResources: number

  maxRequests?: number

  acquireTimeout?: number
  disposeTimeout?: number
  borrowTimeout?: number
  idleTimeout?: number

  syncInterval?: number
  resourceMaxAge?: number
}

export interface BorrowOptions {
  timeout?: number
}

export type Borrowed<T> = [T, () => void]

interface ObjectInfo {
  created: number
}

export enum RequestCancellationReason {
  Destroyed,
  MaxQueuedRequestsExceeded,
  Timeout,
}

export class TimeoutError extends Error {
  public constructor(msg = "timeout") {
    super(msg)
    Object.setPrototypeOf(this, TimeoutError.prototype)
    this.name = "TimeoutError"
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TimeoutError)
    }
    this.message = msg
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Pool<T> {
  onCreate?: () => void
  onDispose?: () => void
  onBorrow?: () => void
  onReturn?: () => void
  onRequestEnqueued?: () => void
  onRequestDequeued?: () => void
  onRequestCancelled?: (reason: RequestCancellationReason) => void
}

abstract class Pool<T> {
  protected options: Options
  private ending = false

  private known: Map<T, ObjectInfo> = new Map()
  private available: Array<T> = []
  private queue: Array<Deferred<Borrowed<T>>> = []

  private syncTimeout?: NodeJS.Timer
  private syncing?: Promise<void>

  constructor(opts: Options) {
    this.options = opts

    if (opts.syncInterval) {
      this.syncTimeout = setInterval(() => {
        if (!this.syncing) {
          this.syncing = this.sync().then(() => (this.syncing = undefined))
        }
      }, opts.syncInterval)
    }

    // start pool
    setTimeout(() => {
      this.syncing = this.sync()
    }, 0)
  }

  protected abstract create(): Promise<T>
  private _create = async (): Promise<T> => {
    this.onCreate?.()
    return this.create()
  }

  protected abstract dispose(rsc: T): Promise<void>
  private _dispose = async (rsc: T): Promise<void> => {
    this.onDispose?.()
    return this.dispose(rsc)
  }

  public borrow = async (options?: BorrowOptions): Promise<Borrowed<T>> => {
    if (this.ending) {
      throw new Error("pool is ending")
    }

    const rsc = this.available.shift()
    if (rsc && this.resourceIsExpired(rsc)) {
      this.removeResource(rsc)
    } else if (rsc) {
      const val: Borrowed<T> = [rsc, () => this.returnResource(rsc)]
      this.onBorrow?.()

      return Promise.resolve(val)
    }

    const future = new Deferred<Borrowed<T>>()
    this.queue.push(future)
    this.onRequestEnqueued?.()

    // sync pool, which may add a resource for this request; or it may reject it
    // for being over the queue limit. don't wait for that here, just sync and
    // return the promise to the caller
    if (!this.syncing) {
      this.syncing = this.sync().then(() => (this.syncing = undefined))
    }

    // handle resource acquisition timeout, if any
    const timeout = options?.timeout ?? this.options.borrowTimeout
    if (timeout) {
      let tid: NodeJS.Timer
      return Promise.race([
        future.promise.finally(() => clearTimeout(tid)),
        new Promise<Borrowed<T>>((resolve, reject) => {
          setTimeout(() => {
            const idx = this.queue.indexOf(future)
            if (idx !== undefined) {
              this.onRequestCancelled?.(RequestCancellationReason.Timeout)
              this.onRequestDequeued?.()
              this.queue.splice(idx, 1)
            }
            reject(new TimeoutError())
          }, timeout)
        }),
      ])
    }

    return future.promise
  }

  public get outstandingRequests(): number {
    return this.queue.length
  }

  public remove = async (rsc: T): Promise<void> => {
    return this.removeResource(rsc)
  }

  public destroy = async (): Promise<void> => {
    this.ending = true

    // stop pool sync, if it's doing so on interval
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout)
    }

    // reject all queued requests
    this.queue.splice(0, this.queue.length).forEach((p) => {
      this.onRequestCancelled?.(RequestCancellationReason.Destroyed)
      this.onRequestDequeued?.()
      p.reject(new Error("pool is ending"))
    })

    // drain available pool
    const promises = this.available
      .splice(0, this.available.length)
      .map(this.removeResource)

    return Promise.all(promises).then()
  }

  private addResource = async (rsc: T): Promise<void> => {
    if (this.known.get(rsc)) {
      throw new Error(
        "addResource called on a resource that already exists in the pool"
      )
    }
    const info: ObjectInfo = {
      created: Date.now(),
    }
    this.known.set(rsc, info)

    return this.maybeLendResource(rsc)
  }

  private maybeLendResource = async (rsc: T): Promise<void> => {
    // see if there's a waiting borrower that can use the resource
    const deferred = this.queue.shift()

    // if not, put it back in the pool
    if (!deferred) {
      this.available.push(rsc)
      return
    }

    this.onRequestDequeued?.()
    this.onBorrow?.()
    // lend the resource
    const borrow: Borrowed<T> = [rsc, () => this.returnResource(rsc)]
    return deferred.resolve(borrow)
  }

  private returnResource = async (rsc: T): Promise<void> => {
    const info = this.known.get(rsc)
    if (!info) {
      throw new Error("return resource called for unknown object")
    }
    this.onReturn?.()

    const { resourceMaxAge } = this.options

    // dispose of the resource if it's aged out
    if (resourceMaxAge && Date.now() - info.created > resourceMaxAge) {
      return this.removeResource(rsc)
    }

    return this.maybeLendResource(rsc)
  }

  private removeResource = (rsc: T): Promise<void> => {
    this.known.delete(rsc)
    const idx = this.available.indexOf(rsc)
    if (idx > -1) {
      this.available.slice(idx, 1)
    }

    return this._dispose(rsc)
  }

  private resourceIsExpired = (rsc: T): boolean => {
    const { resourceMaxAge = Infinity } = this.options
    const info = this.known.get(rsc)
    if (!info) {
      throw new Error("object is unknown to this pool")
    }

    return Date.now() - info.created > resourceMaxAge
  }

  private sync = async (): Promise<void> => {
    const promises: Promise<unknown>[] = []
    const { maxResources, minResources, maxRequests = Infinity } = this.options

    // expire out of date resources
    this.available = this.available.slice().filter((rsc) => {
      if (!this.resourceIsExpired(rsc)) {
        promises.push(this.removeResource(rsc))
        return
      }

      return true
    })

    // grow resource pool if allowed/necessary
    const currentSize = this.known.size
    const deficit = this.queue.length
    const requestedSize = Math.max(
      minResources,
      Math.min(currentSize + deficit, maxResources)
    )
    const toCreate = Math.max(requestedSize - currentSize, 0)

    for (let i = 0; i < toCreate; ++i) {
      promises.push(this._create().then((rsc) => this.addResource(rsc)))
    }

    // reject any queued requests over the queue limit
    if (this.queue.length > maxRequests) {
      this.queue
        .splice(maxRequests, this.queue.length - maxRequests)
        .forEach((future) => {
          this.onRequestCancelled?.(
            RequestCancellationReason.MaxQueuedRequestsExceeded
          )
          this.onRequestDequeued?.()
          future.reject(new Error("queue length exceeded"))
        })
    }

    return Promise.all(promises).then()
  }
}

export default Pool
