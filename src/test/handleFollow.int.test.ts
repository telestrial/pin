// Handle-follow auto-Watch, driven through the production orchestration
// (followHandle / reconcileOneHandle / sweepHandleFollow / unfollowHandle)
// against the Phase 3 fakes + real zustand stores. Two simulated accounts:
// alice follows bob, whose public channels carry K in their records, so the
// reconcile can build functional Watches without a subscribe URL.

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

import type { Agent } from '@atproto/api'
import { followHandle, unfollowHandle } from '../core/handleFollow'
import type { CreatedChannel } from '../core/channels'
import {
  reconcileOneHandle,
  sweepHandleFollow,
} from '../lib/hooks/useHandleFollowReconciliation'
import { useAuthStore } from '../stores/auth'
import {
  authorCreateChannel,
  createFakeApp,
  type FakeAccount,
  mountAs,
  resetAllStores,
} from './setupFakeApp'

const ALICE_DID = 'did:plc:alice00000000000000000'
const BOB_DID = 'did:plc:bob0000000000000000000'

type Setup = {
  alice: FakeAccount
  bob: FakeAccount
  ch1: CreatedChannel
  ch2: CreatedChannel
}

// bob publishes two public channels (each createChannel writes the record
// with its K + a self-follow claim); alice is mounted signed-in with no subs.
async function setup(): Promise<Setup> {
  const app = createFakeApp()
  const alice = app.createAccount({ did: ALICE_DID, handle: 'alice.test' })
  const bob = app.createAccount({ did: BOB_DID, handle: 'bob.test' })
  const ch1 = await authorCreateChannel(bob, { name: 'Bob Music' })
  const ch2 = await authorCreateChannel(bob, { name: 'Bob Code' })
  mountAs(alice)
  return { alice, bob, ch1, ch2 }
}

function aliceAgent(alice: FakeAccount): Agent {
  return alice.agent as unknown as Agent
}

beforeEach(() => {
  resetAllStores()
})

describe('handle-follow auto-Watch (integration)', () => {
  it('following a person auto-Watches all their claimed public channels', async () => {
    const { alice, bob, ch1, ch2 } = await setup()
    await followHandle(aliceAgent(alice), bob.did)
    const added = await reconcileOneHandle(bob.did)

    expect(added).toBe(2)
    const subs = useAuthStore.getState().subscriptions
    expect(subs.map((s) => s.channelID).sort()).toEqual(
      [ch1.channelID, ch2.channelID].sort(),
    )
    // Each Watch carries K (so it's functional) + bob's resolved identity.
    const s1 = subs.find((s) => s.channelID === ch1.channelID)
    expect(s1?.channelKey).toBe(ch1.channelKey)
    expect(s1?.authorDID).toBe(bob.did)
    expect(s1?.authorHandle).toBe('bob.test')
  })

  it('reconcile is idempotent — re-running adds nothing new', async () => {
    const { alice, bob } = await setup()
    await followHandle(aliceAgent(alice), bob.did)
    await reconcileOneHandle(bob.did)
    const addedAgain = await reconcileOneHandle(bob.did)

    expect(addedAgain).toBe(0)
    expect(useAuthStore.getState().subscriptions).toHaveLength(2)
  })

  it('a manual unsubscribe sticks even while still following the person', async () => {
    const { alice, bob, ch1, ch2 } = await setup()
    await followHandle(aliceAgent(alice), bob.did)
    await reconcileOneHandle(bob.did)

    // Drop one of bob's channels — it tombstones.
    useAuthStore.getState().removeSubscription(ch1.channelID)
    expect(useAuthStore.getState().dismissedAutoWatch).toContain(ch1.channelID)

    // Reconciling again must NOT resurrect it; ch2 stays.
    const added = await reconcileOneHandle(bob.did)
    expect(added).toBe(0)
    expect(useAuthStore.getState().subscriptions.map((s) => s.channelID)).toEqual(
      [ch2.channelID],
    )
  })

  it('unfollowing sweeps all their feeds out and clears tombstones for a clean re-follow', async () => {
    const { alice, bob, ch1, ch2 } = await setup()
    const agent = aliceAgent(alice)
    await followHandle(agent, bob.did)
    await reconcileOneHandle(bob.did)

    // Manually drop ch1 first (tombstone), so the sweep exercises both the
    // held channel (ch2) and the already-dropped one (ch1).
    useAuthStore.getState().removeSubscription(ch1.channelID)

    await unfollowHandle(agent, bob.did)
    const removed = await sweepHandleFollow(bob.did)

    // Only ch2 was still held, so 1 removed; both feeds now gone.
    expect(removed).toBe(1)
    expect(useAuthStore.getState().subscriptions).toHaveLength(0)
    // Clean slate: neither channel is tombstoned, so re-following re-adds both.
    const dismissed = useAuthStore.getState().dismissedAutoWatch
    expect(dismissed).not.toContain(ch1.channelID)
    expect(dismissed).not.toContain(ch2.channelID)

    await followHandle(agent, bob.did)
    const readded = await reconcileOneHandle(bob.did)
    expect(readded).toBe(2)
  })
})
