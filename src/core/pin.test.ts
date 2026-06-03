import { describe, expect, it } from 'vitest'
import type { Sdk } from '@siafoundation/sia-storage'
import { fetchAccountSnapshot, fetchRawContentBytes } from './pin'
import { createFakeWorld, FakeSdk } from '../test/fakeSdk'

function asSdk(fake: FakeSdk): Sdk {
  return fake as unknown as Sdk
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
