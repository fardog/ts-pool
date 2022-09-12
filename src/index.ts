import { Deferred } from "./utils"

export interface Options {
  minResources: number
  maxResources: number
  resourceMaxAge?: number

  maxOutstandingBorrows?: number
  defaultBorrowTimeout?: number

  syncInterval?: number
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

export class MaxOutstandingBorrowsError extends Error {
  public constructor(msg = "max outstanding borrows exceeded") {
    super(msg)
    Object.setPrototypeOf(this, MaxOutstandingBorrowsError.prototype)
    this.name = "MaxOutstandingBorrowsError"
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MaxOutstandingBorrowsError)
    }
    this.message = msg
  }
}

export class PoolDestroyedError extends Error {
  public constructor(msg = "pool is destroyed") {
    super(msg)
    Object.setPrototypeOf(this, PoolDestroyedError.prototype)
    this.name = "PoolDestroyedError"
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PoolDestroyedError)
    }
    this.message = msg
  }
}

export class UnknownResourceError extends Error {
  public constructor(msg = "resource is unknown to this pool") {
    super(msg)
    Object.setPrototypeOf(this, UnknownResourceError.prototype)
    this.name = "UnknownResourceError"
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, UnknownResourceError)
    }
    this.message = msg
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Pool<T> {
  onCreate?: () => void
  onDispose?: () => void
  onBorrow?: () => void
  onRelease?: () => void
  onRequestEnqueued?: () => void
  onRequestDequeued?: () => void
  onRequestCancelled?: (reason: RequestCancellationReason) => void
}

abstract class Pool<T> {
  protected options: Options
  private isDestroying = false

  private knownResources: Map<T, ObjectInfo> = new Map()
  private availableResources: Array<T> = []
  private outstandingBorrows: Array<Deferred<Borrowed<T>>> = []

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
    if (this.isDestroying) {
      throw new PoolDestroyedError()
    }

    const rsc = this.availableResources.shift()
    if (rsc && this.resourceIsExpired(rsc)) {
      this.removeResource(rsc)
    } else if (rsc) {
      const val: Borrowed<T> = [rsc, () => this.returnResource(rsc)]
      this.onBorrow?.()

      return Promise.resolve(val)
    }

    const future = new Deferred<Borrowed<T>>()
    this.outstandingBorrows.push(future)
    this.onRequestEnqueued?.()

    // sync pool, which may add a resource for this request; or it may reject it
    // for being over the queue limit. don't wait for that here, just sync and
    // return the promise to the caller
    if (!this.syncing) {
      this.syncing = this.sync().then(() => (this.syncing = undefined))
    }

    // handle resource acquisition timeout, if any
    const timeout = options?.timeout ?? this.options.defaultBorrowTimeout
    if (timeout) {
      let tid: NodeJS.Timer
      return Promise.race([
        future.promise.finally(() => clearTimeout(tid)),
        new Promise<Borrowed<T>>((resolve, reject) => {
          setTimeout(() => {
            const idx = this.outstandingBorrows.indexOf(future)
            if (idx !== undefined) {
              this.onRequestCancelled?.(RequestCancellationReason.Timeout)
              this.onRequestDequeued?.()
              this.outstandingBorrows.splice(idx, 1)
            }
            reject(new TimeoutError())
          }, timeout)
        }),
      ])
    }

    // no timeout to handle, just return the promise
    return future.promise
  }

  public get outstandingBorrowsCount(): number {
    return this.outstandingBorrows.length
  }

  public remove = async (rsc: T): Promise<void> => {
    return this.removeResource(rsc)
  }

  public destroy = async (): Promise<void> => {
    this.isDestroying = true

    // stop pool sync, if it's doing so on interval
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout)
    }

    // reject all queued requests
    this.outstandingBorrows
      .splice(0, this.outstandingBorrows.length)
      .forEach((p) => {
        this.onRequestCancelled?.(RequestCancellationReason.Destroyed)
        this.onRequestDequeued?.()
        p.reject(new PoolDestroyedError())
      })

    // drain available pool
    const promises = this.availableResources
      .splice(0, this.availableResources.length)
      .map(this.removeResource)

    return Promise.all(promises).then()
  }

  private addResource = async (rsc: T): Promise<void> => {
    if (this.knownResources.get(rsc)) {
      throw new Error(
        "addResource called on a resource that already exists in the pool"
      )
    }
    const info: ObjectInfo = {
      created: Date.now(),
    }
    this.knownResources.set(rsc, info)

    return this.maybeLendResource(rsc)
  }

  private maybeLendResource = async (rsc: T): Promise<void> => {
    // see if there's a waiting borrower that can use the resource
    const deferred = this.outstandingBorrows.shift()

    // if not, put it back in the pool
    if (!deferred) {
      this.availableResources.push(rsc)
      return
    }

    this.onRequestDequeued?.()
    this.onBorrow?.()
    // lend the resource
    const borrow: Borrowed<T> = [rsc, () => this.returnResource(rsc)]
    return deferred.resolve(borrow)
  }

  private returnResource = async (rsc: T): Promise<void> => {
    const info = this.knownResources.get(rsc)
    if (!info) {
      throw new UnknownResourceError()
    }
    this.onRelease?.()

    const { resourceMaxAge } = this.options

    // dispose of the resource if it's aged out
    if (resourceMaxAge && Date.now() - info.created > resourceMaxAge) {
      return this.removeResource(rsc)
    }

    return this.maybeLendResource(rsc)
  }

  private removeResource = (rsc: T): Promise<void> => {
    this.knownResources.delete(rsc)
    const idx = this.availableResources.indexOf(rsc)
    if (idx > -1) {
      this.availableResources.slice(idx, 1)
    }

    return this._dispose(rsc)
  }

  private resourceIsExpired = (rsc: T): boolean => {
    const { resourceMaxAge = Infinity } = this.options
    const info = this.knownResources.get(rsc)
    if (!info) {
      throw new UnknownResourceError()
    }

    return Date.now() - info.created > resourceMaxAge
  }

  private sync = async (): Promise<void> => {
    const promises: Promise<unknown>[] = []
    const {
      maxResources,
      minResources,
      maxOutstandingBorrows: maxRequests = Infinity,
    } = this.options

    // expire out of date resources
    this.availableResources = this.availableResources.slice().filter((rsc) => {
      if (!this.resourceIsExpired(rsc)) {
        promises.push(this.removeResource(rsc))
        return
      }

      return true
    })

    // grow resource pool if allowed/necessary
    const currentSize = this.knownResources.size
    const deficit = this.outstandingBorrows.length
    const requestedSize = Math.max(
      minResources,
      Math.min(currentSize + deficit, maxResources)
    )
    const toCreate = Math.max(requestedSize - currentSize, 0)

    for (let i = 0; i < toCreate; ++i) {
      promises.push(this._create().then((rsc) => this.addResource(rsc)))
    }

    // reject any queued requests over the queue limit
    if (this.outstandingBorrows.length > maxRequests) {
      this.outstandingBorrows
        .splice(maxRequests, this.outstandingBorrows.length - maxRequests)
        .forEach((future) => {
          this.onRequestCancelled?.(
            RequestCancellationReason.MaxQueuedRequestsExceeded
          )
          this.onRequestDequeued?.()
          future.reject(new MaxOutstandingBorrowsError())
        })
    }

    return Promise.all(promises).then()
  }
}

export default Pool
