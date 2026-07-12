import { describe, expect, it, vi } from 'vitest'
import { CHANNEL_LEXICON } from '../core/atproto'
import { FakeAgent } from './fakeAgent'
import { type CommitEvent, connectFakeJetstream } from './fakeJetstream'
import { createFakeWorld } from './fakeSdk'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

function setup() {
  const world = createFakeWorld()
  const alice = new FakeAgent(ALICE, world)
  const bob = new FakeAgent(BOB, world)
  if (!world.records) throw new Error('records should be initialized')
  return { world, alice, bob, store: world.records }
}

describe('connectFakeJetstream', () => {
  it('fires onConnected immediately when initialDids is non-empty', () => {
    const { store } = setup()
    const onConnected = vi.fn()
    connectFakeJetstream(store, [ALICE], {
      onCommit: () => {},
      onConnected,
    })
    expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire onConnected when initialDids is empty', () => {
    const { store } = setup()
    const onConnected = vi.fn()
    connectFakeJetstream(store, [], {
      onCommit: () => {},
      onConnected,
    })
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('fires onCommit when a watched DID writes a channel record', async () => {
    const { store, alice } = setup()
    const events: CommitEvent[] = []
    connectFakeJetstream(store, [ALICE], {
      onCommit: (e) => events.push(e),
    })
    await alice.com.atproto.repo.putRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: 'r1',
      record: {},
    })
    expect(events).toEqual([{ did: ALICE, rkey: 'r1', operation: 'create' }])
  })

  it('does not fire for DIDs outside the filter', async () => {
    const { store, alice, bob } = setup()
    const events: CommitEvent[] = []
    connectFakeJetstream(store, [BOB], {
      onCommit: (e) => events.push(e),
    })
    await alice.com.atproto.repo.putRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: 'r1',
      record: {},
    })
    expect(events).toHaveLength(0)
    await bob.com.atproto.repo.putRecord({
      repo: BOB,
      collection: CHANNEL_LEXICON,
      rkey: 'r2',
      record: {},
    })
    expect(events).toHaveLength(1)
    expect(events[0].rkey).toBe('r2')
  })

  it('does not fire for unrelated collections (e.g. app.bsky.feed.post)', async () => {
    const { store, alice } = setup()
    const events: CommitEvent[] = []
    connectFakeJetstream(store, [ALICE], {
      onCommit: (e) => events.push(e),
    })
    await alice.com.atproto.repo.putRecord({
      repo: ALICE,
      collection: 'app.bsky.feed.post',
      rkey: 'x',
      record: {},
    })
    expect(events).toHaveLength(0)
  })

  it('update(newDids) replaces the filter; new DID gets events, old does not', async () => {
    const { store, alice, bob } = setup()
    const events: CommitEvent[] = []
    const conn = connectFakeJetstream(store, [ALICE], {
      onCommit: (e) => events.push(e),
    })

    await alice.com.atproto.repo.putRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: 'a1',
      record: {},
    })
    expect(events).toHaveLength(1)

    conn.update([BOB])

    await alice.com.atproto.repo.putRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: 'a2',
      record: {},
    })
    await bob.com.atproto.repo.putRecord({
      repo: BOB,
      collection: CHANNEL_LEXICON,
      rkey: 'b1',
      record: {},
    })

    expect(events).toHaveLength(2)
    expect(events[1].rkey).toBe('b1')
  })

  it('update([]) detaches and fires onDisconnected', () => {
    const { store } = setup()
    const onDisconnected = vi.fn()
    const conn = connectFakeJetstream(store, [ALICE], {
      onCommit: () => {},
      onDisconnected,
    })
    conn.update([])
    expect(onDisconnected).toHaveBeenCalledTimes(1)
  })

  it('close() detaches; no further onCommit even on matching writes', async () => {
    const { store, alice } = setup()
    const events: CommitEvent[] = []
    const onDisconnected = vi.fn()
    const conn = connectFakeJetstream(store, [ALICE], {
      onCommit: (e) => events.push(e),
      onDisconnected,
    })
    conn.close()
    expect(onDisconnected).toHaveBeenCalledTimes(1)
    await alice.com.atproto.repo.putRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: 'r',
      record: {},
    })
    expect(events).toHaveLength(0)
  })

  it('fires delete events too (retraction propagation)', async () => {
    const { store, alice } = setup()
    const events: CommitEvent[] = []
    connectFakeJetstream(store, [ALICE], {
      onCommit: (e) => events.push(e),
    })
    await alice.com.atproto.repo.putRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: 'doomed',
      record: {},
    })
    await alice.com.atproto.repo.deleteRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: 'doomed',
    })
    expect(events.map((e) => e.operation)).toEqual(['create', 'delete'])
  })
})
