import Pool, {
  Options,
  Borrowed,
  RequestCancellationReason,
  TimeoutError,
} from "./"

describe("basic test case", () => {
  type HookCounts = {
    onCreate: number
    onDispose: number
    onBorrow: number
    onReturn: number
    onRequestEnqueued: number
    onRequestDequeued: number
    onRequestCancelled: RequestCancellationReason[]
  }
  const options: Options = {
    minResources: 0,
    maxResources: 10,
  }
  let createCount = 0
  let disposeCount = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disposed: jest.Mock<any, any>[] = []

  class TestPool extends Pool<jest.Mock> {
    public hookCounts: HookCounts = {
      onCreate: 0,
      onDispose: 0,
      onBorrow: 0,
      onReturn: 0,
      onRequestEnqueued: 0,
      onRequestDequeued: 0,
      onRequestCancelled: [],
    }
    create(): Promise<jest.Mock> {
      createCount++
      return Promise.resolve(jest.fn())
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dispose(rsc: jest.Mock<any, any>): Promise<void> {
      disposeCount++
      disposed.push(rsc)
      return Promise.resolve()
    }

    // instrumentation
    onCreate = () => this.hookCounts.onCreate++
    onDispose = () => this.hookCounts.onDispose++
    onBorrow = () => this.hookCounts.onBorrow++
    onRequestEnqueued = () => this.hookCounts.onRequestEnqueued++
    onRequestDequeued = () => this.hookCounts.onRequestDequeued++
    onRequestCancelled = (reason: RequestCancellationReason) =>
      this.hookCounts.onRequestCancelled.push(reason)
  }

  afterEach(() => {
    createCount = 0
    disposeCount = 0
    disposed.splice(0, disposed.length)
  })

  test("borrow returns same resource after release", async () => {
    const pool = new TestPool(options)

    const [rsc, release] = await pool.borrow()
    expect(rsc).toBeTruthy()
    expect(rsc).toBeCalledTimes(0)

    // call for later assertion, and release
    rsc()
    await release()

    const [rsc2] = await pool.borrow()

    expect(rsc2).toBeCalledTimes(1)
    // verify is same resource
    expect(rsc2).toBe(rsc)

    // verify hooks
    expect(pool.hookCounts).toEqual(
      createHookCounts({
        onCreate: 1,
        onBorrow: 2,
        onRequestEnqueued: 1,
        onRequestDequeued: 1,
      })
    )
  })

  test("borrow returns different resources", async () => {
    const pool = new TestPool(options)

    const [rsc1] = await pool.borrow()
    const [rsc2] = await pool.borrow()

    expect(rsc1).toBeTruthy()
    expect(rsc2).toBeTruthy()
    expect(rsc1).not.toBe(rsc2)

    // verify hooks
    expect(pool.hookCounts).toEqual(
      createHookCounts({
        onCreate: 2,
        onBorrow: 2,
        onRequestEnqueued: 2,
        onRequestDequeued: 2,
      })
    )
  })

  test("borrow cannot exceed cap", async () => {
    expect.assertions(2)

    const pool = new TestPool({ minResources: 0, maxResources: 2 })

    const [rsc1, release1] = await pool.borrow()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_, release2] = await pool.borrow()

    pool.borrow().then(([rsc]) => {
      expect(rsc).toBe(rsc1)
    })

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        release1()
        release2()
        setTimeout(() => {
          expect(pool.hookCounts).toEqual(
            createHookCounts({
              onCreate: 2,
              onBorrow: 3,
              onRequestEnqueued: 3,
              onRequestDequeued: 3,
            })
          )
          pool.destroy().then(() => resolve())
        }, 10)
      }, 10)
    })
  })

  test("pool with minimum set allocates resources", async () => {
    expect.assertions(2)

    const pool = new TestPool({ minResources: 5, maxResources: 10 })

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(createCount).toEqual(5)
        expect(pool.hookCounts).toEqual(
          createHookCounts({
            onCreate: 5,
          })
        )

        pool.destroy().then(() => resolve())
      }, 10)
    })
  })

  test("resource borrow timeout", async () => {
    expect.assertions(4)

    const pool = new TestPool({ minResources: 0, maxResources: 1 })

    // consume the only resource available in the pool
    await pool.borrow()

    const pending = pool.borrow({ timeout: 10 })

    expect(pool.outstandingRequests).toBe(1)

    await expect(pending).rejects.toThrow(TimeoutError)

    expect(pool.outstandingRequests).toBe(0)

    expect(pool.hookCounts).toEqual(
      createHookCounts({
        onBorrow: 1,
        onCreate: 1,
        onRequestEnqueued: 2,
        onRequestDequeued: 2,
        onRequestCancelled: [RequestCancellationReason.Timeout],
      })
    )
  })

  test("pool rejects in-flight borrows on destroy", async () => {
    expect.assertions(11)
    const pool = new TestPool({ minResources: 0, maxResources: 10 })

    const borrows: Promise<Borrowed<jest.Mock>>[] = []
    for (let i = 0; i < 10; i++) {
      borrows.push(pool.borrow())
    }

    pool.destroy().then()

    const promises = borrows.map((borrow) =>
      borrow
        .then(() => {
          throw new Error("fail: borrow should not succeed")
        })
        .catch((e) => expect(e).toBeTruthy())
    )

    await Promise.all(promises).then(() =>
      expect(pool.hookCounts).toEqual(
        createHookCounts({
          onCreate: 1,
          onRequestEnqueued: 10,
          onRequestDequeued: 10,
          onRequestCancelled: new Array(10).fill(
            RequestCancellationReason.Destroyed
          ),
        })
      )
    )
  })

  test("pool ends all resources on destroy", async () => {
    expect.assertions(3)
    const pool = new TestPool({ minResources: 5, maxResources: 10 })

    // borrow a resource to fully sync the pool
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_, release] = await pool.borrow()
    release()

    await pool.destroy().then(() => {
      expect(createCount).toBe(5)
      expect(disposeCount).toBe(5)
      expect(pool.hookCounts).toEqual(
        createHookCounts({
          onBorrow: 1,
          onCreate: 5,
          onDispose: 5,
          onRequestEnqueued: 1,
          onRequestDequeued: 1,
        })
      )
    })
  })

  function createHookCounts(countsPartial: Partial<HookCounts>): HookCounts {
    return {
      onCreate: 0,
      onDispose: 0,
      onBorrow: 0,
      onReturn: 0,
      onRequestEnqueued: 0,
      onRequestDequeued: 0,
      onRequestCancelled: [],
      ...countsPartial,
    }
  }
})
