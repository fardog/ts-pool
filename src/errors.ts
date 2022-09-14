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
