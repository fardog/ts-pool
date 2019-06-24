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

export type Borrowed<T> = [T, () => void]

interface ObjectInfo {
  created: number
}

export class Deferred<T> {
  public promise: Promise<T>
  public resolve!: (value: T) => void
  public reject!: (reason: any) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

abstract class Pool<T> {
  protected options: Options
  private ending: boolean = false

  private known: Map<T, ObjectInfo> = new Map()
  private available: Array<T> = []
  private queue: Array<Deferred<Borrowed<T>>> = []

  private syncTimeout?: number
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

  abstract create(): Promise<T>
  abstract dispose(rsc: T): Promise<void>

  public borrow = async (): Promise<Borrowed<T>> => {
    if (this.ending) {
      throw new Error("pool is ending")
    }

    const rsc = this.available.shift()
    if (rsc && this.resourceIsExpired(rsc)) {
      this.removeResource(rsc)
    } else if (rsc) {
      const val: Borrowed<T> = [rsc, () => this.returnResource(rsc)]

      return Promise.resolve(val)
    }

    const future = new Deferred<Borrowed<T>>()
    this.queue.push(future)

    // sync pool, which may add a resource for this request; or it may reject it
    // for being over the queue limit. don't wait for that here, just sync and
    // return the promise to the caller
    if (!this.syncing) {
      this.syncing = this.sync().then(() => (this.syncing = undefined))
    }

    return future.promise
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
    this.queue
      .splice(0, this.queue.length)
      .forEach(p => p.reject && p.reject(new Error("pool is ending")))

    // drain available pool
    const promises = this.available
      .splice(0, this.available.length)
      .map(this.removeResource)

    return Promise.all(promises).then(() => {})
  }

  private addResource = async (rsc: T): Promise<void> => {
    if (this.known.get(rsc)) {
      throw new Error(
        "addResource called on a resource that already exists in the pool"
      )
    }
    const info: ObjectInfo = {
      created: Date.now()
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

    // lend the resource
    const borrow: Borrowed<T> = [rsc, () => this.returnResource(rsc)]
    return deferred.resolve(borrow)
  }

  private returnResource = async (rsc: T): Promise<void> => {
    const info = this.known.get(rsc)
    if (!info) {
      throw new Error("return resource called for unknown object")
    }

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

    return this.dispose(rsc)
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
    const promises: Promise<any>[] = []
    const { maxResources, minResources, maxRequests = Infinity } = this.options

    // expire out of date resources
    this.available = this.available.slice().filter(rsc => {
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
      promises.push(this.create().then(rsc => this.addResource(rsc)))
    }

    // reject any queued requests over the queue limit
    if (this.queue.length > maxRequests) {
      this.queue
        .splice(maxRequests, this.queue.length - maxRequests)
        .forEach(future => {
          if (future.reject) future.reject(new Error("queue length exceeded"))
        })
    }

    return Promise.all(promises).then(() => {})
  }
}

export default Pool
