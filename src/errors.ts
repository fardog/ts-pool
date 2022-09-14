/**
 * Thrown when a timeout occurs.
 * @public
 */
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

/**
 * Thrown when the number of borrows is exceeded, and a request is rejected.
 * @public
 */
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

/**
 * Thrown when an operation is performed on a pool that is destroyed, or in the
 * process of being destroyed.
 * @public
 */
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

/**
 * Thrown when an operation is requested on a resource which is not known to the
 * pool.
 * @public
 */
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
