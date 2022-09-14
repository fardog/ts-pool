import {
  MaxOutstandingBorrowsError,
  PoolDestroyedError,
  TimeoutError,
  UnknownResourceError,
} from "./errors"
import { Deferred } from "./utils"

/**
 * Pool options, passed when initializing the pool.
 * @public
 */
export interface Options {
  /**
   * The minimum number of resources to keep in the pool; a positive integer.
   */
  minResources: number
  /**
   * The maximum number of resources the pool may contain; a positive integer.
   */
  maxResources: number
  /**
   * The maximum age of a resource, after which it will be considered invalid
   * and be disposed of.
   *
   * A positive integer, in milliseconds.
   */
  resourceMaxAge?: number

  /**
   * The maximum number of outstanding borrows which may be queued; any further
   * borrows will be rejected. When not provided, an unlimited number of
   * outstanding borrows are allowed.
   *
   * A positive integer.
   */
  maxOutstandingBorrows?: number
  /**
   * The time a borrow request is allowed to wait for an available resource
   * before the request is rejected. When not provided, the default is
   * `Infinity`.
   *
   * A positive integer, in milliseconds.
   */
  defaultBorrowTimeout?: number

  /**
   * How often the pool is synchronized; during a synchronization, resources are
   * expired and disposed, and new resources are created to keep the pool at its
   * minimum.
   *
   * When not specified, this process only happens on borrow. This is sufficient
   * unless your use of the pool is very sporadic, and so it's not recommended
   * to set a `syncInterval` except in those cases.
   *
   * A positive integer, in milliseconds.
   */
  syncInterval?: number
}

/**
 * Borrow options, which may be optionally passed when borrowing a resource from
 * the pool.
 * @public
 */
export interface BorrowOptions {
  /**
   * The time a borrow request is allowed to wait for an available resource
   * before the request is rejected. The default specified in the pool options
   * is used.
   *
   * A positive integer, in milliseconds.
   */
  timeout?: number
}

/**
 * A tuple of the borrowed resource, and a function to call to return that
 * resource.
 * @public
 */
export type Borrowed<T> = [T, () => void]

interface ObjectInfo {
  created: number
}

/**
 * The reason a request was cancelled.
 * @public
 */
export enum RequestCancellationReason {
  /**
   * The pool was destroyed.
   */
  Destroyed,
  /**
   * The max number of borrows, specified in the pool options as
   * `maxOutstandingBorrows`, was exceeded.
   */
  MaxQueuedRequestsExceeded,
  /**
   * The borrow wasn't able to be fulfilled in the allowed timeout.
   */
  Timeout,
}

/* eslint-disable @typescript-eslint/no-unused-vars */

/**
 * Abstract class Pool, which will be implemented to create a custom resource
 * pool.
 * @public
 */
export interface Pool<T> {
  /**
   * Called when a resource is borrowed.
   */
  onBorrow?: () => void
  /**
   * Called when a resource is released.
   */
  onRelease?: () => void
  /**
   * Called when a request is enqueued for later fulfillment.
   */
  onRequestEnqueued?: () => void
  /**
   * Called when a waiting request is dequeued and fulfilled.
   */
  onRequestDequeued?: () => void
  /**
   * Called when a request is cancelled, with the reason.
   */
  onRequestCancelled?: (reason: RequestCancellationReason) => void
}

/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Abstract class Pool, which will be implemented to create a custom resource
 * pool.
 * @public
 */
export abstract class Pool<T> {
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

  /**
   * Abstract method that is called to create new resources to populate the
   * pool.
   */
  protected abstract create(): Promise<T>
  private _create = async (): Promise<T> => {
    return this.create()
  }

  /**
   * Abstract method that is called to dispose of a resource when it expires from
   * the pool.
   * @param rsc - the resource to be disposed.
   */
  protected abstract dispose(rsc: T): Promise<void>
  private _dispose = async (rsc: T): Promise<void> => {
    return this.dispose(rsc)
  }

  /**
   * Borrow a resource from the pool.
   * @param options - borrow options
   * @returns The borrowed resource, and a function to be called to return it.
   */
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

  /**
   * Get the count of outstanding borrows waiting for a resource to become
   * available.
   */
  public get outstandingBorrowsCount(): number {
    return this.outstandingBorrows.length
  }

  /**
   * Remove a resource from the pool.
   * @param rsc - the resource to be removed
   * @returns a promise which resolves when the resource is removed.
   */
  public remove = async (rsc: T): Promise<void> => {
    return this.removeResource(rsc)
  }

  /**
   * Destroy the pool.
   * @returns a promise which resolves when the pool is destroyed.
   */
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
      if (this.resourceIsExpired(rsc)) {
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

    return Promise.all(promises).then(() => {
      if (
        this.outstandingBorrows.length > 0 &&
        this.knownResources.size < maxResources
      ) {
        // a request came in while we were syncing; sync again
        return this.sync()
      }
    })
  }
}
