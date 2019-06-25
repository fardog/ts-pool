# ts-pool

A generic resource pool implementation in [Typescript][].

**Warning:** This implementation has tests, but I haven't used it anywhere yet;
it probably has bugs and oversights. I wrote it off the top of my head as an
exercise, without any real planning. If I use this in real code, I'll remove
this warning and actually publish it.

[Typescript]: https://www.typescriptlang.org/

## Example

```typescript
import Pool from 'ts-pool'

class Resource {
    doCoolThing(): Promise<string> {
        return Promise.resolve("cool")
    }
    end(): Promise<void> {
        return Promise.resolve()
    }
}

class TestPool extends Pool<Resource> {
    create(): Promise<Resource> {
      return Promise.resolve(new Resource())
    }
    dispose(rsc: Resource): Promise<void> {
      return rsc.end()
    }
}

async function usePool() {
    const pool = new TestPool({minResources: 0, maxResources: 10})
    const [resource, dispose] = await pool.borrow()

    console.log(await resource.doCoolThing()) // "cool"
    await dispose()
}

usePool()
```

## License

[MIT](./LICENSE)
