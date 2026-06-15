import type { Agent } from '@atproto/api'
import { describe, expect, it } from 'vitest'
import { FakeAgent, FakeRecordStore } from '../test/fakeAgent'
import { FakeWorld } from '../test/fakeSdk'
import {
  HANDLEFOLLOW_LEXICON,
  type HandleFollowRecord,
  followHandle,
  rkeyForHandleSubject,
  unfollowHandle,
} from './handleFollow'

const DID_A = 'did:plc:alice00000000000000000'
const DID_B = 'did:plc:bob0000000000000000000'

// Set the shared store up explicitly so it's a definite reference (the
// FakeWorld.records field is optional until a FakeAgent initializes it).
function makeWorld(): { world: FakeWorld; store: FakeRecordStore } {
  const world = new FakeWorld()
  world.records = new FakeRecordStore()
  return { world, store: world.records }
}

function agentFor(did: string, world: FakeWorld): Agent {
  return new FakeAgent(did, world) as unknown as Agent
}

describe('rkeyForHandleSubject', () => {
  it('produces a 16-character lowercase base32 rkey', async () => {
    const rkey = await rkeyForHandleSubject(DID_B)
    expect(rkey).toMatch(/^[a-z2-7]{16}$/)
  })

  it('is deterministic for the same DID', async () => {
    const a = await rkeyForHandleSubject(DID_B)
    const b = await rkeyForHandleSubject(DID_B)
    expect(a).toBe(b)
  })

  it('differs across DIDs', async () => {
    const a = await rkeyForHandleSubject(DID_A)
    const b = await rkeyForHandleSubject(DID_B)
    expect(a).not.toBe(b)
  })
})

describe('followHandle', () => {
  it('writes a handle-follow record at the derived rkey under the follower repo', async () => {
    const { world, store } = makeWorld()
    const agent = agentFor(DID_A, world)

    await followHandle(agent, DID_B)

    const rkey = await rkeyForHandleSubject(DID_B)
    const stored = store.get(DID_A, HANDLEFOLLOW_LEXICON, rkey)
    expect(stored).toBeDefined()
    const value = stored?.value as HandleFollowRecord
    expect(value.$type).toBe(HANDLEFOLLOW_LEXICON)
    expect(value.subject).toBe(DID_B)
    expect(typeof value.createdAt).toBe('string')
  })

  it('is idempotent — re-following the same person reuses one record', async () => {
    const { world, store } = makeWorld()
    const agent = agentFor(DID_A, world)

    await followHandle(agent, DID_B)
    await followHandle(agent, DID_B)

    expect(store.list(DID_A, HANDLEFOLLOW_LEXICON)).toHaveLength(1)
  })

  it('keeps separate records for separate subjects', async () => {
    const { world, store } = makeWorld()
    const agent = agentFor(DID_A, world)

    await followHandle(agent, DID_B)
    await followHandle(agent, 'did:plc:carol000000000000000000')

    expect(store.list(DID_A, HANDLEFOLLOW_LEXICON)).toHaveLength(2)
  })
})

describe('unfollowHandle', () => {
  it('deletes the record written by followHandle', async () => {
    const { world, store } = makeWorld()
    const agent = agentFor(DID_A, world)

    await followHandle(agent, DID_B)
    await unfollowHandle(agent, DID_B)

    const rkey = await rkeyForHandleSubject(DID_B)
    expect(store.get(DID_A, HANDLEFOLLOW_LEXICON, rkey)).toBeUndefined()
  })
})
