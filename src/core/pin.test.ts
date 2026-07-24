import type { Sdk } from '@siafoundation/sia-storage'
import { describe, expect, it } from 'vitest'
import { createFakeWorld, FakeSdk } from '../test/fakeSdk'
import {
  fetchAccountSnapshot,
  fetchRawContentBytes,
  pinItem,
  pinItemBytes,
  unpinItemBytes,
} from './pin'
import type { SiaClient } from './siaClient'
import type { ItemRef } from './types'

function asSdk(fake: FakeSdk): Sdk {
  return fake as unknown as Sdk
}

// A SiaClient over a FakeSdk, built here (NOT via makeWasmSiaClient) so this
// unit test — which doesn't mock @siafoundation/sia-storage — never pulls the
// real WASM module in through core/sia. Only pinFromShareURL is exercised (by
// pinItem); the rest throw if reached.
function asClient(fake: FakeSdk): SiaClient {
  const sdk = fake as unknown as Sdk
  const unused = async (): Promise<never> => {
    throw new Error('SiaClient method not used in this test')
  }
  return {
    uploadItem: unused,
    uploadItemsPacked: unused,
    downloadItem: unused,
    pinFromShareURL: (url) => pinItemBytes(sdk, url),
    resolveObjectID: async (url) => (await fake.sharedObject(url)).id(),
    deleteObject: (id) => fake.deleteObject(id),
    pruneSlabs: () => fake.pruneSlabs(),
    accountSnapshot: () => fetchAccountSnapshot(sdk),
    listPinnedObjects: unused,
    getObjectSlabs: async () => null,
    appKeyPublicKey: () => fake.appKey().publicKey(),
  }
}

async function uploadBytes(fake: FakeSdk, bytes: Uint8Array): Promise<void> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  await fake.upload(null, stream)
}

// Upload bytes into one account's scope and return a share URL another
// account can resolve — the cross-account mirror path pinItem walks.
async function uploadAndShare(
  fake: FakeSdk,
  bytes: Uint8Array,
): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  const obj = await fake.upload(null, stream)
  return fake.shareObject(obj, new Date())
}

function makeItem(itemURL: string, attachmentURLs: string[] = []): ItemRef {
  return {
    id: 'item',
    itemURL,
    type: 'text',
    title: '',
    summary: '',
    publishedAt: '2026-01-01T00:00:00.000Z',
    mimeType: 'text/markdown',
    byteSize: 100,
    attachments: attachmentURLs.map((url) => ({
      url,
      mimeType: 'application/octet-stream',
      byteSize: 1,
    })),
  }
}

describe('fetchRawContentBytes', () => {
  it('returns 0 for an empty scope', async () => {
    const world = createFakeWorld()
    const fake = new FakeSdk('alice', world)
    expect(await fetchRawContentBytes(asSdk(fake))).toBe(0)
  })

  it('sums slab lengths across every pinned object', async () => {
    const world = createFakeWorld()
    const fake = new FakeSdk('alice', world)
    await uploadBytes(fake, new Uint8Array(100))
    await uploadBytes(fake, new Uint8Array(250))
    await uploadBytes(fake, new Uint8Array(50))
    expect(await fetchRawContentBytes(asSdk(fake))).toBe(400)
  })

  it('only counts objects in the calling account scope', async () => {
    const world = createFakeWorld()
    const alice = new FakeSdk('alice', world)
    const bob = new FakeSdk('bob', world)
    await uploadBytes(alice, new Uint8Array(100))
    await uploadBytes(alice, new Uint8Array(200))
    await uploadBytes(bob, new Uint8Array(9999))
    expect(await fetchRawContentBytes(asSdk(alice))).toBe(300)
    expect(await fetchRawContentBytes(asSdk(bob))).toBe(9999)
  })

  it('drops deleted objects from the sum after refresh', async () => {
    const world = createFakeWorld()
    const fake = new FakeSdk('alice', world)
    await uploadBytes(fake, new Uint8Array(100))
    await uploadBytes(fake, new Uint8Array(200))
    expect(await fetchRawContentBytes(asSdk(fake))).toBe(300)
    // Drop one object from the scope and re-measure.
    const firstID = Array.from(world.scopeOf('alice'))[0]
    await fake.deleteObject(firstID)
    const before = world.scopeOf('alice').size
    expect(before).toBe(1)
    expect(await fetchRawContentBytes(asSdk(fake))).toBeLessThan(300)
  })
})

describe('pinItem / unpinItemBytes', () => {
  it('mirrors body + every attachment into the caller scope', async () => {
    const world = createFakeWorld()
    const alice = new FakeSdk('alice', world)
    const bob = new FakeSdk('bob', world)
    const bodyURL = await uploadAndShare(alice, new Uint8Array(100))
    const imgURL = await uploadAndShare(alice, new Uint8Array(200))
    const audURL = await uploadAndShare(alice, new Uint8Array(300))

    const { objectID, attachmentObjectIDs } = await pinItem(
      asClient(bob),
      makeItem(bodyURL, [imgURL, audURL]),
    )

    expect(attachmentObjectIDs).toHaveLength(2)
    expect(world.scopeOf('bob').size).toBe(3)
    expect(world.scopeOf('bob').has(objectID)).toBe(true)
    for (const aid of attachmentObjectIDs) {
      expect(world.scopeOf('bob').has(aid)).toBe(true)
    }
  })

  it('pins body-only when there are no attachments', async () => {
    const world = createFakeWorld()
    const alice = new FakeSdk('alice', world)
    const bob = new FakeSdk('bob', world)
    const bodyURL = await uploadAndShare(alice, new Uint8Array(100))

    const { attachmentObjectIDs } = await pinItem(
      asClient(bob),
      makeItem(bodyURL),
    )

    expect(attachmentObjectIDs).toHaveLength(0)
    expect(world.scopeOf('bob').size).toBe(1)
  })

  it('skips malformed attachments rather than crashing', async () => {
    const world = createFakeWorld()
    const alice = new FakeSdk('alice', world)
    const bob = new FakeSdk('bob', world)
    const bodyURL = await uploadAndShare(alice, new Uint8Array(100))
    const goodURL = await uploadAndShare(alice, new Uint8Array(200))

    const item = makeItem(bodyURL, [goodURL])
    // Inject pre-schema garbage alongside the valid attachment.
    item.attachments = [
      ...(item.attachments ?? []),
      'bare-string-url' as unknown as never,
      { mimeType: 'image/png' } as unknown as never,
    ]

    const { attachmentObjectIDs } = await pinItem(asClient(bob), item)
    expect(attachmentObjectIDs).toHaveLength(1)
    expect(world.scopeOf('bob').size).toBe(2)
  })

  it('unpinItemBytes releases an object from the caller scope', async () => {
    const world = createFakeWorld()
    const alice = new FakeSdk('alice', world)
    const bob = new FakeSdk('bob', world)
    const bodyURL = await uploadAndShare(alice, new Uint8Array(100))
    const imgURL = await uploadAndShare(alice, new Uint8Array(200))

    const { objectID, attachmentObjectIDs } = await pinItem(
      asClient(bob),
      makeItem(bodyURL, [imgURL]),
    )
    expect(world.scopeOf('bob').size).toBe(2)

    // The store orchestrates whole-item release; the primitive drops one id.
    await unpinItemBytes(asSdk(bob), objectID)
    for (const aid of attachmentObjectIDs) await unpinItemBytes(asSdk(bob), aid)
    expect(world.scopeOf('bob').size).toBe(0)
  })

  it("unpinItemBytes leaves the author's scope intact (custody is independent)", async () => {
    const world = createFakeWorld()
    const alice = new FakeSdk('alice', world)
    const bob = new FakeSdk('bob', world)
    const bodyURL = await uploadAndShare(alice, new Uint8Array(100))
    const imgURL = await uploadAndShare(alice, new Uint8Array(200))
    expect(world.scopeOf('alice').size).toBe(2)

    const { objectID, attachmentObjectIDs } = await pinItem(
      asClient(bob),
      makeItem(bodyURL, [imgURL]),
    )
    await unpinItemBytes(asSdk(bob), objectID)
    for (const aid of attachmentObjectIDs) await unpinItemBytes(asSdk(bob), aid)

    // bob let go; alice still hosts both objects.
    expect(world.scopeOf('bob').size).toBe(0)
    expect(world.scopeOf('alice').size).toBe(2)
  })
})

describe('fetchAccountSnapshot', () => {
  it('returns rawContentBytes alongside the SDK account fields', async () => {
    const world = createFakeWorld()
    const fake = new FakeSdk('alice', world)
    await uploadBytes(fake, new Uint8Array(500))
    await uploadBytes(fake, new Uint8Array(750))
    const snap = await fetchAccountSnapshot(asSdk(fake))
    expect(snap.rawContentBytes).toBe(1250)
    expect(snap.maxPinnedData).toBeGreaterThan(0)
    expect(Number.isFinite(snap.pinnedData)).toBe(true)
    expect(Number.isFinite(snap.remainingStorage)).toBe(true)
    expect(snap.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('rawContentBytes is finite (and 0) for an empty account', async () => {
    const world = createFakeWorld()
    const fake = new FakeSdk('alice', world)
    const snap = await fetchAccountSnapshot(asSdk(fake))
    expect(snap.rawContentBytes).toBe(0)
    expect(Number.isFinite(snap.rawContentBytes)).toBe(true)
  })
})
