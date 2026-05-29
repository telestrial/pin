import { describe, expect, it } from 'vitest'
import { createFakeWorld, FakeSdk } from './fakeSdk'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function streamToString(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return DECODER.decode(out)
}

describe('FakeSdk', () => {
  describe('single account', () => {
    it('upload registers bytes and pins them under the calling account', async () => {
      const world = createFakeWorld()
      const sdk = new FakeSdk('alice', world)

      const obj = await sdk.upload({}, streamOf(ENCODER.encode('hi')))
      expect(obj.id()).toBeTruthy()
      expect(obj.size()).toBe(2)
      expect(world.scopeOf('alice').has(obj.id())).toBe(true)
      expect(Array.from(world.bytesOf(obj.id()) ?? [])).toEqual(
        Array.from(ENCODER.encode('hi')),
      )
    })

    it("download returns a stream of the originally-uploaded bytes", async () => {
      const world = createFakeWorld()
      const sdk = new FakeSdk('alice', world)

      const obj = await sdk.upload({}, streamOf(ENCODER.encode('hello world')))
      const text = await streamToString(sdk.download(obj))
      expect(text).toBe('hello world')
    })

    it('shareObject mints a sia://fake/<id>#k=<key> URL', async () => {
      const world = createFakeWorld()
      const sdk = new FakeSdk('alice', world)
      const obj = await sdk.upload({}, streamOf(ENCODER.encode('hi')))

      const url = sdk.shareObject(obj, new Date('9999-12-31'))
      expect(url).toMatch(/^sia:\/\/fake\/[0-9a-f]+#k=[0-9a-f]+$/)
    })

    it('sharedObject(URL) resolves back to a handle with the same bytes', async () => {
      const world = createFakeWorld()
      const sdk = new FakeSdk('alice', world)
      const original = await sdk.upload({}, streamOf(ENCODER.encode('original')))
      const url = sdk.shareObject(original, new Date('9999-12-31'))

      const resolved = await sdk.sharedObject(url)
      expect(resolved.id()).toBe(original.id())
      const text = await streamToString(sdk.download(resolved))
      expect(text).toBe('original')
    })

    it('sharedObject rejects malformed URLs', async () => {
      const sdk = new FakeSdk('alice', createFakeWorld())
      await expect(sdk.sharedObject('https://not-sia.test/x')).rejects.toThrow(
        /Bad share URL/,
      )
    })

    it('sharedObject rejects URLs whose object has been deleted', async () => {
      const world = createFakeWorld()
      const sdk = new FakeSdk('alice', world)
      const obj = await sdk.upload({}, streamOf(ENCODER.encode('gone')))
      const url = sdk.shareObject(obj, new Date('9999-12-31'))
      await sdk.deleteObject(obj.id())
      await expect(sdk.sharedObject(url)).rejects.toThrow(/Object not found/)
    })

    it('deleteObject removes the bytes from the only scope holding them', async () => {
      const world = createFakeWorld()
      const sdk = new FakeSdk('alice', world)
      const obj = await sdk.upload({}, streamOf(ENCODER.encode('bye')))
      expect(world.objects.has(obj.id())).toBe(true)
      await sdk.deleteObject(obj.id())
      expect(world.objects.has(obj.id())).toBe(false)
      expect(world.scopeOf('alice').has(obj.id())).toBe(false)
    })

    it('account() reports pinnedData as the sum of byte sizes in scope', async () => {
      const world = createFakeWorld()
      const sdk = new FakeSdk('alice', world)
      await sdk.upload({}, streamOf(new Uint8Array(100)))
      await sdk.upload({}, streamOf(new Uint8Array(250)))
      const snap = await sdk.account()
      expect(snap.pinnedData).toBe(350)
      expect(snap.pinnedSize).toBe(350 * 3)
      expect(snap.remainingStorage).toBe(snap.maxPinnedData - 350)
    })

    it('appKey().publicKey() returns a deterministic per-account string', () => {
      const world = createFakeWorld()
      const a = new FakeSdk('alice', world)
      const b = new FakeSdk('bob', world)
      expect(a.appKey().publicKey()).toBe('appkey-alice')
      expect(b.appKey().publicKey()).toBe('appkey-bob')
    })
  })

  describe('cross-account capability (the load-bearing property)', () => {
    it("B can sharedObject A's URL and read the bytes without pinning first", async () => {
      const world = createFakeWorld()
      const alice = new FakeSdk('alice', world)
      const bob = new FakeSdk('bob', world)

      const obj = await alice.upload({}, streamOf(ENCODER.encode("Alice's post")))
      const url = alice.shareObject(obj, new Date('9999-12-31'))

      const handle = await bob.sharedObject(url)
      const text = await streamToString(bob.download(handle))
      expect(text).toBe("Alice's post")
      // Bob has not pinned yet — bytes aren't in his scope.
      expect(world.scopeOf('bob').has(obj.id())).toBe(false)
    })

    it("B pinObject mirrors A's bytes into B's scope; account() reflects it", async () => {
      const world = createFakeWorld()
      const alice = new FakeSdk('alice', world)
      const bob = new FakeSdk('bob', world)

      const obj = await alice.upload({}, streamOf(new Uint8Array(500)))
      const url = alice.shareObject(obj, new Date('9999-12-31'))
      const handle = await bob.sharedObject(url)
      await bob.pinObject(handle)

      expect((await alice.account()).pinnedData).toBe(500)
      expect((await bob.account()).pinnedData).toBe(500)
      expect(world.scopeOf('alice').has(obj.id())).toBe(true)
      expect(world.scopeOf('bob').has(obj.id())).toBe(true)
    })

    it("A deleting their own copy doesn't strip B's pinned snapshot (custody persists)", async () => {
      const world = createFakeWorld()
      const alice = new FakeSdk('alice', world)
      const bob = new FakeSdk('bob', world)

      const obj = await alice.upload({}, streamOf(ENCODER.encode('captured')))
      const url = alice.shareObject(obj, new Date('9999-12-31'))
      const handle = await bob.sharedObject(url)
      await bob.pinObject(handle)

      await alice.deleteObject(obj.id())

      // Alice's scope is empty, Bob still has it.
      expect(world.scopeOf('alice').has(obj.id())).toBe(false)
      expect(world.scopeOf('bob').has(obj.id())).toBe(true)
      // Bob can still resolve and download — bytes survive because at least
      // one pinner remains.
      const stillThere = await bob.sharedObject(url)
      const text = await streamToString(bob.download(stillThere))
      expect(text).toBe('captured')
    })

    it("when the last pinner deletes, bytes drop from the universe", async () => {
      const world = createFakeWorld()
      const alice = new FakeSdk('alice', world)
      const bob = new FakeSdk('bob', world)

      const obj = await alice.upload({}, streamOf(ENCODER.encode('temporary')))
      const url = alice.shareObject(obj, new Date('9999-12-31'))
      const handle = await bob.sharedObject(url)
      await bob.pinObject(handle)

      await alice.deleteObject(obj.id())
      expect(world.objects.has(obj.id())).toBe(true) // still bob's
      await bob.deleteObject(obj.id())
      expect(world.objects.has(obj.id())).toBe(false) // gone
    })
  })

  describe('uploadPacked', () => {
    it('finalize returns N handles with distinct IDs, all in the registry', async () => {
      const world = createFakeWorld()
      const sdk = new FakeSdk('alice', world)
      const packed = sdk.uploadPacked()
      await packed.add(streamOf(ENCODER.encode('one')))
      await packed.add(streamOf(ENCODER.encode('two')))
      await packed.add(streamOf(ENCODER.encode('three')))
      const handles = await packed.finalize()
      expect(handles).toHaveLength(3)
      expect(new Set(handles.map((h) => h.id())).size).toBe(3)
      for (const h of handles) {
        expect(world.objects.has(h.id())).toBe(true)
      }
    })

    it('finalize does NOT auto-pin — caller must pinObject on each handle', async () => {
      // Matches the real SDK contract: sia.ts:uploadItemsPacked calls pinObject
      // after finalize on every result. The fake faithfully leaves that step
      // to the caller so the test catches any regression that drops it.
      const world = createFakeWorld()
      const sdk = new FakeSdk('alice', world)
      const packed = sdk.uploadPacked()
      await packed.add(streamOf(ENCODER.encode('a')))
      const [obj] = await packed.finalize()
      expect(world.scopeOf('alice').has(obj.id())).toBe(false)
      await sdk.pinObject(obj)
      expect(world.scopeOf('alice').has(obj.id())).toBe(true)
    })
  })
})
