// The `SiaClient` contract, exercised against the fake.
//
// Worth testing rather than assuming, because every integration test now depends on
// this fake being faithful: it is what stands in for Sia across the whole tier, so a
// wrong custody rule here would quietly validate broken behaviour everywhere else.
//
// The assertions are written against the SiaClient surface rather than the fake's
// internals, so they read as the contract any implementation owes — the fake today,
// and a real client if one is ever exercised here.

import { describe, expect, it } from 'vitest'
import { createFakeWorld, FakeSiaClient } from './fakeSia'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

function twoAccounts() {
  const world = createFakeWorld()
  return {
    world,
    alice: new FakeSiaClient('alice', world),
    bob: new FakeSiaClient('bob', world),
  }
}

describe('byte ops', () => {
  it('uploads to a plain descriptor and downloads the same bytes back', async () => {
    const { alice } = twoAccounts()
    const uploaded = await alice.uploadItem(ENCODER.encode('hello sia'))

    expect(uploaded.id).toBeTruthy()
    expect(uploaded.itemURL).toMatch(/^sia:\/\//)
    expect(uploaded.byteSize).toBe(9)
    // A real CIDv1 of the plaintext, so cache keys and drift detection behave as
    // they do live rather than against a placeholder.
    expect(uploaded.contentHash).toBeTruthy()

    const got = await alice.downloadItem(uploaded.itemURL)
    expect(DECODER.decode(got)).toBe('hello sia')
  })

  it('gives identical bytes the same content hash and different bytes a different one', async () => {
    const { alice } = twoAccounts()
    const a = await alice.uploadItem(ENCODER.encode('same'))
    const b = await alice.uploadItem(ENCODER.encode('same'))
    const c = await alice.uploadItem(ENCODER.encode('different'))

    expect(b.contentHash).toBe(a.contentHash)
    expect(c.contentHash).not.toBe(a.contentHash)
    // Same content, still separate objects with their own URLs.
    expect(b.id).not.toBe(a.id)
  })

  it('returns one descriptor per packed input, in order', async () => {
    const { alice } = twoAccounts()
    const out = await alice.uploadItemsPacked([
      ENCODER.encode('a'),
      ENCODER.encode('bb'),
      ENCODER.encode('ccc'),
    ])

    expect(out.map((o) => o.byteSize)).toEqual([1, 2, 3])
    expect(new Set(out.map((o) => o.id)).size).toBe(3)
  })

  it('reports shard progress when a callback is given', async () => {
    const { alice } = twoAccounts()
    let shards = 0
    await alice.uploadItem(ENCODER.encode('x'), () => {
      shards++
    })
    expect(shards).toBeGreaterThan(0)
  })

  it('rejects a malformed share URL', async () => {
    const { alice } = twoAccounts()
    await expect(alice.downloadItem('https://not-sia.test/x')).rejects.toThrow(
      /Bad share URL/,
    )
  })
})

// The property everything else rests on: a share URL is identity-agnostic, so
// possessing one is what grants access — not being the account that uploaded it.
describe('cross-account custody', () => {
  it("lets one account read another's URL without pinning it", async () => {
    const { world, alice, bob } = twoAccounts()
    const uploaded = await alice.uploadItem(ENCODER.encode("Alice's post"))

    const got = await bob.downloadItem(uploaded.itemURL)
    expect(DECODER.decode(got)).toBe("Alice's post")
    // Reading is not custody — nothing entered bob's scope.
    expect(world.scopeOf('bob').has(uploaded.id)).toBe(false)
  })

  it('mirrors bytes into the pinning account, leaving the author holding them too', async () => {
    const { world, alice, bob } = twoAccounts()
    const uploaded = await alice.uploadItem(new Uint8Array(500))

    const { objectID } = await bob.pinFromShareURL(uploaded.itemURL)

    expect(objectID).toBe(uploaded.id)
    expect(world.scopeOf('alice').has(uploaded.id)).toBe(true)
    expect(world.scopeOf('bob').has(uploaded.id)).toBe(true)
    expect((await alice.accountSnapshot()).pinnedData).toBe(500)
    expect((await bob.accountSnapshot()).pinnedData).toBe(500)
  })

  it('resolves an object id without taking custody', async () => {
    const { world, alice, bob } = twoAccounts()
    const uploaded = await alice.uploadItem(new Uint8Array(10))

    expect(await bob.resolveObjectID(uploaded.itemURL)).toBe(uploaded.id)
    expect(world.scopeOf('bob').has(uploaded.id)).toBe(false)
  })

  // The custody promise: a pinned copy is the pinner's, and the author retracting
  // does not reach into it.
  it('survives the author deleting their own copy', async () => {
    const { world, alice, bob } = twoAccounts()
    const uploaded = await alice.uploadItem(ENCODER.encode('captured'))
    await bob.pinFromShareURL(uploaded.itemURL)

    await alice.deleteObject(uploaded.id)

    expect(world.scopeOf('alice').has(uploaded.id)).toBe(false)
    expect(world.scopeOf('bob').has(uploaded.id)).toBe(true)
    const got = await bob.downloadItem(uploaded.itemURL)
    expect(DECODER.decode(got)).toBe('captured')
  })

  it('drops the bytes only once the last holder lets go', async () => {
    const { world, alice, bob } = twoAccounts()
    const uploaded = await alice.uploadItem(ENCODER.encode('temporary'))
    await bob.pinFromShareURL(uploaded.itemURL)

    await alice.deleteObject(uploaded.id)
    expect(world.objects.has(uploaded.id)).toBe(true)

    await bob.deleteObject(uploaded.id)
    expect(world.objects.has(uploaded.id)).toBe(false)
  })

  it('rejects a URL whose object is gone', async () => {
    const { alice } = twoAccounts()
    const uploaded = await alice.uploadItem(ENCODER.encode('gone'))
    await alice.deleteObject(uploaded.id)
    await expect(alice.downloadItem(uploaded.itemURL)).rejects.toThrow(
      /Object not found/,
    )
  })
})

// The accounting the storage meter, the repack scope and the full-reset walk read.
describe('accounting', () => {
  it('reports an empty scope as zero rather than something unusable', async () => {
    const { alice } = twoAccounts()
    const snapshot = await alice.accountSnapshot()
    expect(snapshot.pinnedData).toBe(0)
    expect(snapshot.rawContentBytes).toBe(0)
    expect(Number.isFinite(snapshot.rawContentBytes)).toBe(true)
    expect(await alice.listPinnedObjects()).toEqual([])
  })

  it('sums content bytes across everything held', async () => {
    const { alice } = twoAccounts()
    await alice.uploadItem(new Uint8Array(100))
    await alice.uploadItem(new Uint8Array(250))
    await alice.uploadItem(new Uint8Array(50))

    const snapshot = await alice.accountSnapshot()
    expect(snapshot.rawContentBytes).toBe(400)
    expect(snapshot.pinnedData).toBe(400)
    expect(snapshot.pinnedSize).toBe(400 * 3)
    expect(snapshot.remainingStorage).toBe(snapshot.maxPinnedData - 400)
  })

  // Scope isolation is the whole point of the walk — it must answer "what do I
  // hold", never "what exists".
  it('counts only what the calling account holds', async () => {
    const { alice, bob } = twoAccounts()
    await alice.uploadItem(new Uint8Array(100))
    await alice.uploadItem(new Uint8Array(200))
    await bob.uploadItem(new Uint8Array(9999))

    expect((await alice.accountSnapshot()).rawContentBytes).toBe(300)
    expect((await bob.accountSnapshot()).rawContentBytes).toBe(9999)
  })

  it('stops counting an object once it is released', async () => {
    const { alice } = twoAccounts()
    const first = await alice.uploadItem(new Uint8Array(100))
    await alice.uploadItem(new Uint8Array(200))
    expect((await alice.accountSnapshot()).rawContentBytes).toBe(300)

    await alice.deleteObject(first.id)

    expect((await alice.accountSnapshot()).rawContentBytes).toBe(200)
    expect(await alice.listPinnedObjects()).toHaveLength(1)
  })

  it('describes each held object with the slabs its byte total is summed from', async () => {
    const { alice } = twoAccounts()
    const uploaded = await alice.uploadItem(new Uint8Array(128))

    const [info] = await alice.listPinnedObjects()
    expect(info.id).toBe(uploaded.id)
    expect(Date.parse(info.createdAt)).not.toBeNaN()
    expect(info.slabs.reduce((n, s) => n + s.length, 0)).toBe(128)

    expect(await alice.getObjectSlabs(uploaded.id)).toMatchObject({
      id: uploaded.id,
    })
  })

  // Repack asks about references that may already be gone, so absence is an answer
  // rather than a failure.
  it('answers null for an object it does not hold', async () => {
    const { alice, bob } = twoAccounts()
    const uploaded = await alice.uploadItem(new Uint8Array(10))
    expect(await bob.getObjectSlabs(uploaded.id)).toBeNull()
    expect(await alice.getObjectSlabs('nonexistent')).toBeNull()
  })
})

describe('identity', () => {
  it('gives each account a stable, distinct key', () => {
    const { alice, bob } = twoAccounts()
    expect(alice.appKeyPublicKey()).toBe('appkey-alice')
    expect(bob.appKeyPublicKey()).toBe('appkey-bob')
  })
})
