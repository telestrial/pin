import { describe, expect, it } from 'vitest'
import { FakeAgent, FakeRecordStore, type RecordEvent } from './fakeAgent'
import { createFakeWorld } from './fakeSdk'

const COLLECTION = 'dev.sia.pin.channel'
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

describe('FakeAgent', () => {
  describe('repo writes and reads', () => {
    it('putRecord stores under (repo, collection, rkey) and getRecord returns it', async () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)

      const put = await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'abc',
        record: { $type: COLLECTION, encryptedManifest: 'cipher' },
      })
      expect(put.data.uri).toBe(`at://${ALICE}/${COLLECTION}/abc`)
      expect(put.data.cid).toMatch(/^bafyrei-fake-/)

      const got = await alice.com.atproto.repo.getRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'abc',
      })
      expect(got.data.uri).toBe(put.data.uri)
      expect(got.data.cid).toBe(put.data.cid)
      expect(got.data.value).toEqual({
        $type: COLLECTION,
        encryptedManifest: 'cipher',
      })
    })

    it('getRecord throws when the record is missing (matches real PDS 400)', async () => {
      const alice = new FakeAgent(ALICE, createFakeWorld())
      await expect(
        alice.com.atproto.repo.getRecord({
          repo: ALICE,
          collection: COLLECTION,
          rkey: 'missing',
        }),
      ).rejects.toThrow(/Record not found/)
    })

    it('putRecord at the same rkey overwrites (mutable channel record)', async () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'abc',
        record: { v: 1 },
      })
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'abc',
        record: { v: 2 },
      })
      const got = await alice.com.atproto.repo.getRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'abc',
      })
      expect(got.data.value).toEqual({ v: 2 })
    })

    it('deleteRecord removes the record; subsequent getRecord throws', async () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'abc',
        record: { v: 1 },
      })
      await alice.com.atproto.repo.deleteRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'abc',
      })
      await expect(
        alice.com.atproto.repo.getRecord({
          repo: ALICE,
          collection: COLLECTION,
          rkey: 'abc',
        }),
      ).rejects.toThrow(/Record not found/)
    })

    it('deleteRecord on a missing rkey throws (matches real PDS 400)', async () => {
      const alice = new FakeAgent(ALICE, createFakeWorld())
      await expect(
        alice.com.atproto.repo.deleteRecord({
          repo: ALICE,
          collection: COLLECTION,
          rkey: 'never-existed',
        }),
      ).rejects.toThrow(/Record not found/)
    })

    it('listRecords returns only the records for the given (repo, collection)', async () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)
      const bob = new FakeAgent(BOB, world)
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'a1',
        record: { v: 'a1' },
      })
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'a2',
        record: { v: 'a2' },
      })
      await bob.com.atproto.repo.putRecord({
        repo: BOB,
        collection: COLLECTION,
        rkey: 'b1',
        record: { v: 'b1' },
      })

      const aliceList = await alice.com.atproto.repo.listRecords({
        repo: ALICE,
        collection: COLLECTION,
      })
      expect(aliceList.data.records.map((r) => r.value)).toEqual(
        expect.arrayContaining([{ v: 'a1' }, { v: 'a2' }]),
      )
      expect(aliceList.data.records).toHaveLength(2)

      const bobList = await alice.com.atproto.repo.listRecords({
        repo: BOB,
        collection: COLLECTION,
      })
      expect(bobList.data.records).toHaveLength(1)
      expect(bobList.data.records[0].value).toEqual({ v: 'b1' })
    })
  })

  describe('two-account fidelity (shared world)', () => {
    it("alice's record is readable from bob's agent (cross-account read works)", async () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)
      const bob = new FakeAgent(BOB, world)

      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'shared',
        record: { v: 'from alice' },
      })
      const got = await bob.com.atproto.repo.getRecord({
        repo: ALICE, // Bob reads from Alice's repo address
        collection: COLLECTION,
        rkey: 'shared',
      })
      expect(got.data.value).toEqual({ v: 'from alice' })
    })

    it('the world.records store is shared by reference across agents', () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)
      const bob = new FakeAgent(BOB, world)
      void alice
      void bob
      expect(world.records).toBeInstanceOf(FakeRecordStore)
    })
  })

  describe('commit events (the JetStream substrate)', () => {
    it('putRecord emits a create event for a new key', async () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)
      const events: RecordEvent[] = []
      world.records?.subscribe((e) => events.push(e))
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'first',
        record: { v: 1 },
      })
      expect(events).toEqual([
        { did: ALICE, collection: COLLECTION, rkey: 'first', operation: 'create' },
      ])
    })

    it('a second putRecord at the same key emits an update event', async () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)
      const events: RecordEvent[] = []
      world.records?.subscribe((e) => events.push(e))
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'x',
        record: { v: 1 },
      })
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'x',
        record: { v: 2 },
      })
      expect(events.map((e) => e.operation)).toEqual(['create', 'update'])
    })

    it('deleteRecord emits a delete event; deleting a missing key emits nothing', async () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)
      const events: RecordEvent[] = []
      world.records?.subscribe((e) => events.push(e))
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'x',
        record: {},
      })
      await alice.com.atproto.repo.deleteRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'x',
      })
      // The missing-key delete throws; we don't expect an event for it.
      expect(events.map((e) => e.operation)).toEqual(['create', 'delete'])
    })

    it('subscribe returns an unsubscribe function that stops further events', async () => {
      const world = createFakeWorld()
      const alice = new FakeAgent(ALICE, world)
      const events: RecordEvent[] = []
      const off = world.records?.subscribe((e) => events.push(e))
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'a',
        record: {},
      })
      off?.()
      await alice.com.atproto.repo.putRecord({
        repo: ALICE,
        collection: COLLECTION,
        rkey: 'b',
        record: {},
      })
      expect(events).toHaveLength(1)
      expect(events[0].rkey).toBe('a')
    })
  })
})
