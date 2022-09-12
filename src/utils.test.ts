import { Deferred } from "./utils"

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
