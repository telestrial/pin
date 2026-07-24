import type { Sdk } from '@siafoundation/sia-storage'
import { describe, expect, it } from 'vitest'
import { createFakeWorld, FakeSdk } from '../test/fakeSdk'
import { makeWasmSiaClient } from './siaClient'

// Wrapping the existing FakeSdk in the real makeWasmSiaClient does double duty:
// it exercises the wrapper's delegation AND proves the fake still satisfies the
// SDK surface the wrapper depends on.
function clientFor(account = 'alice') {
  const world = createFakeWorld()
  const sdk = new FakeSdk(account, world) as unknown as Sdk
  return { client: makeWasmSiaClient(sdk), world }
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

describe('makeWasmSiaClient', () => {
  it('uploadItem returns a plain descriptor and downloadItem round-trips', async () => {
    const { client } = clientFor()
    const up = await client.uploadItem(ENCODER.encode('hello sia'))
    expect(up.id).toBeTruthy()
    expect(up.itemURL).toMatch(/^sia:\/\//)
    expect(up.byteSize).toBe(9)
    expect(up.contentHash).toBeTruthy()

    const got = await client.downloadItem(up.itemURL)
    expect(DECODER.decode(got)).toBe('hello sia')
  })

  it('uploadItemsPacked returns one descriptor per input', async () => {
    const { client } = clientFor()
    const items = [
      ENCODER.encode('a'),
      ENCODER.encode('bb'),
      ENCODER.encode('ccc'),
    ]
    const out = await client.uploadItemsPacked(items)
    expect(out).toHaveLength(3)
    expect(out.map((o) => o.byteSize)).toEqual([1, 2, 3])
    expect(new Set(out.map((o) => o.id)).size).toBe(3)
  })

  it('pinFromShareURL mirrors bytes into scope; resolveObjectID resolves without pinning', async () => {
    // Author uploads in one scope; a second scope pins from the share URL.
    const world = createFakeWorld()
    const author = makeWasmSiaClient(
      new FakeSdk('author', world) as unknown as Sdk,
    )
    const reader = makeWasmSiaClient(
      new FakeSdk('reader', world) as unknown as Sdk,
    )

    const up = await author.uploadItem(ENCODER.encode('shared bytes'))

    // resolve does not add to scope
    const resolvedID = await reader.resolveObjectID(up.itemURL)
    expect(resolvedID).toBe(up.id)
    expect((await reader.accountSnapshot()).pinnedData).toBe(0)

    // pin does
    const { objectID } = await reader.pinFromShareURL(up.itemURL)
    expect(objectID).toBe(up.id)
    expect((await reader.accountSnapshot()).pinnedData).toBeGreaterThan(0)
  })

  it('listPinnedObjects returns plain descriptors with slabs for live objects', async () => {
    const { client } = clientFor()
    const up = await client.uploadItem(ENCODER.encode('x'.repeat(100)))

    const objs = await client.listPinnedObjects()
    const mine = objs.find((o) => o.id === up.id)
    expect(mine).toBeDefined()
    expect(typeof mine?.createdAt).toBe('string')
    expect(Array.isArray(mine?.slabs)).toBe(true)
    // descriptor is plain/serializable — no functions on it
    expect(JSON.parse(JSON.stringify(mine))).toMatchObject({ id: up.id })
  })

  it('deleteObject + pruneSlabs removes the object from listing', async () => {
    const { client } = clientFor()
    const up = await client.uploadItem(ENCODER.encode('bye'))
    expect((await client.listPinnedObjects()).some((o) => o.id === up.id)).toBe(
      true,
    )

    await client.deleteObject(up.id)
    await client.pruneSlabs()
    expect((await client.listPinnedObjects()).some((o) => o.id === up.id)).toBe(
      false,
    )
  })

  it('accountSnapshot reports the coarse account shape', async () => {
    const { client } = clientFor()
    await client.uploadItem(ENCODER.encode('y'.repeat(42)))
    const snap = await client.accountSnapshot()
    expect(snap.pinnedData).toBeGreaterThan(0)
    expect(snap.maxPinnedData).toBeGreaterThan(0)
    expect(typeof snap.fetchedAt).toBe('string')
  })

  it('appKeyPublicKey exposes the account identity', () => {
    const { client } = clientFor('alice')
    expect(client.appKeyPublicKey()).toBe('appkey-alice')
  })

  it('getObjectSlabs returns null when the object is unresolvable', async () => {
    // FakeSdk.object() is unimplemented (throws), so the wrapper's catch → null.
    // Documents the null-on-miss contract the real SDK path also honors.
    const { client } = clientFor()
    expect(await client.getObjectSlabs('nope')).toBeNull()
  })
})
