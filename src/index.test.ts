import Pool, { Options, Deferred, Borrowed } from "./"

describe("utility test cases", () => {
  test("deferred has reject/resolve immediately available", async () => {
    const deferred = new Deferred<number>()
    expect(deferred.resolve).toBeTruthy()
    expect(deferred.reject).toBeTruthy()
    deferred.resolve(3)
    expect(await deferred.promise).toBe(3)
  })
  test("deferred promise resolves", async () => {
    const deferred = new Deferred<number>()
    deferred.resolve(3)
    expect(await deferred.promise).toBe(3)
  })
  test("deferred promise reject", async () => {
    const deferred = new Deferred<number>()
    deferred.reject(new Error("dang"))
    try {
      await deferred.promise
      fail("should not resolve")
    } catch (e) {
      expect(e).toBeTruthy()
    }
  })
})

describe("basic test case", () => {
  const options: Options = {
    minResources: 0,
    maxResources: 10,
  }
  let createCount = 0
  let disposeCount = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disposed: jest.Mock<any, any>[] = []

  class TestPool extends Pool<jest.Mock> {
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
  })

  test("borrow returns different resources", async () => {
    const pool = new TestPool(options)

    const [rsc1] = await pool.borrow()
    const [rsc2] = await pool.borrow()

    expect(rsc1).toBeTruthy()
    expect(rsc2).toBeTruthy()
    expect(rsc1).not.toBe(rsc2)
  })

  test("borrow cannot exceed cap", async () => {
    expect.assertions(1)

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
        setTimeout(() => pool.destroy().then(() => resolve()), 10)
      }, 10)
    })
  })

  test("pool with minimum set allocates resources", async () => {
    expect.assertions(1)

    const pool = new TestPool({ minResources: 5, maxResources: 10 })

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(createCount).toEqual(5)
        pool.destroy().then(() => resolve())
      }, 10)
    })
  })

  test("pool rejects in-flight borrows on destroy", async () => {
    expect.assertions(10)
    const pool = new TestPool({ minResources: 0, maxResources: 10 })

    const borrows: Promise<Borrowed<jest.Mock>>[] = []
    for (let i = 0; i < 10; i++) {
      borrows.push(pool.borrow())
    }

    pool.destroy().then()

    borrows.forEach((borrow) => {
      borrow
        .then(() => {
          throw new Error("fail: borrow should not succeed")
        })
        .catch((e) => expect(e).toBeTruthy())
    })
  })

  test("pool ends all resources on destroy", async () => {
    expect.assertions(2)
    const pool = new TestPool({ minResources: 5, maxResources: 10 })

    // borrow a resource to fully sync the pool
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_, release] = await pool.borrow()
    release()

    await pool.destroy().then(() => {
      expect(createCount).toBe(5)
      expect(disposeCount).toBe(5)
    })
  })
})
