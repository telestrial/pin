// Smoke test for the integration-test module mocks. Confirms each
// vi.mock factory returns a working stub that respects the live FakeWorld.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock(
  '@atproto/api',
  async () => (await import('./fakeModules')).fakeAtprotoApiModule(),
)
vi.mock(
  '../core/jetstream',
  async () => (await import('./fakeModules')).fakeJetstreamModule(),
)
vi.mock(
  '@siafoundation/sia-storage',
  async () => (await import('./fakeModules')).fakeSiaStorageModule(),
)

import { AtpAgent } from '@atproto/api'
import { PinnedObject } from '@siafoundation/sia-storage'
import { connectJetstream } from '../core/jetstream'
import { createFakeApp, resetAllStores } from './setupFakeApp'

describe('integration test module mocks', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('AtpAgent is the fake; getRecord reads from the live FakeWorld', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    await alice.agent.com.atproto.repo.putRecord({
      repo: alice.did,
      collection: 'dev.sia.pin.channel',
      rkey: 'r1',
      record: { hello: 'world' },
    })

    const ata = new AtpAgent({ service: 'https://bsky.social' })
    const got = await ata.com.atproto.repo.getRecord({
      repo: alice.did,
      collection: 'dev.sia.pin.channel',
      rkey: 'r1',
    })
    expect(got.data.value).toEqual({ hello: 'world' })
  })

  it('PinnedObject() constructs without WASM init (stub)', () => {
    const obj = new PinnedObject()
    expect(typeof obj.id()).toBe('string')
  })

  it('connectJetstream is the fake; commits flow from FakeAgent writes', async () => {
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })

    const events: { did: string; rkey: string; operation: string }[] = []
    const conn = connectJetstream([alice.did], {
      onCommit: (e) => events.push(e),
    })

    await alice.agent.com.atproto.repo.putRecord({
      repo: alice.did,
      collection: 'dev.sia.pin.channel',
      rkey: 'event-test',
      record: {},
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      did: alice.did,
      rkey: 'event-test',
      operation: 'create',
    })
    conn.close()
  })
})
