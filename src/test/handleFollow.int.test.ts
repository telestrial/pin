// Handle-follow auto-Watch, driven through the production orchestration
// (reconcileOneHandle / sweepHandleFollow) against the Phase 3 fakes + real
// zustand stores. In the iroh model a followed person's public channels come
// from their identity-doc (resolveIdentityDoc, mocked here) — each entry
// carries K, so the reconcile builds functional Watches without a subscribe
// URL. The test exercises the auto-Watch LOGIC (resolve → candidates →
// additions / removals / tombstones), not the pkarr/Sia resolve itself.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@atproto/api', async () =>
  (await import('./fakeModules')).fakeAtprotoApiModule(),
)
vi.mock('@siafoundation/sia-storage', async () =>
  (await import('./fakeModules')).fakeSiaStorageModule(),
)
vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)

// A followed person's advertised channels are served from a mock identity-doc
// keyed by their DID. Hoisted so the vi.mock factory can close over it.
const { directory } = vi.hoisted(() => ({
  directory: {} as Record<
    string,
    Array<{ channelID: string; key: string; name: string }>
  >,
}))
vi.mock('../lib/identityDoc', () => ({
  resolveIdentityDoc: async (_sdk: unknown, didDht: string) =>
    directory[didDht]
      ? {
          version: 2,
          profile: null,
          channels: directory[didDht],
          follows: [],
          handleFollows: [],
          updatedAt: '',
        }
      : null,
  publishIdentityDoc: async () => ({ id: '', url: '' }),
}))

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

// bob publishes two public channels; alice (signed-in, no subs) follows bob's
// identity. bob's channels are registered in the mock identity-doc under his
// DID so reconcile/sweep resolve them (with K).
async function setup(): Promise<Setup> {
  const app = createFakeApp()
  const alice = app.createAccount({ did: ALICE_DID, handle: 'alice.test' })
  const bob = app.createAccount({ did: BOB_DID, handle: 'bob.test' })
  const ch1 = await authorCreateChannel(bob, { name: 'Bob Music' })
  const ch2 = await authorCreateChannel(bob, { name: 'Bob Code' })
  directory[BOB_DID] = [
    { channelID: ch1.channelID, key: ch1.channelKey, name: 'Bob Music' },
    { channelID: ch2.channelID, key: ch2.channelKey, name: 'Bob Code' },
  ]
  mountAs(alice)
  return { alice, bob, ch1, ch2 }
}

beforeEach(() => {
  resetAllStores()
  for (const k of Object.keys(directory)) delete directory[k]
})

describe('handle-follow auto-Watch (integration)', () => {
  it('following a person auto-Watches all their advertised public channels', async () => {
    const { ch1, ch2 } = await setup()
    useAuthStore.getState().addHandleFollow(BOB_DID)
    const added = await reconcileOneHandle(BOB_DID)

    expect(added).toBe(2)
    const subs = useAuthStore.getState().subscriptions
    expect(subs.map((s) => s.channelID).sort()).toEqual(
      [ch1.channelID, ch2.channelID].sort(),
    )
    // Each Watch carries K (so it's functional) + the followed person's did:dht.
    const s1 = subs.find((s) => s.channelID === ch1.channelID)
    expect(s1?.channelKey).toBe(ch1.channelKey)
    expect(s1?.didDht).toBe(BOB_DID)
  })

  it('reconcile is idempotent — re-running adds nothing new', async () => {
    await setup()
    useAuthStore.getState().addHandleFollow(BOB_DID)
    await reconcileOneHandle(BOB_DID)
    const addedAgain = await reconcileOneHandle(BOB_DID)

    expect(addedAgain).toBe(0)
    expect(useAuthStore.getState().subscriptions).toHaveLength(2)
  })

  it('a manual unsubscribe sticks even while still following the person', async () => {
    const { ch1, ch2 } = await setup()
    useAuthStore.getState().addHandleFollow(BOB_DID)
    await reconcileOneHandle(BOB_DID)

    // Drop one of bob's channels — it tombstones.
    useAuthStore.getState().removeSubscription(ch1.channelID)
    expect(useAuthStore.getState().dismissedAutoWatch).toContain(ch1.channelID)

    // Reconciling again must NOT resurrect it; ch2 stays.
    const added = await reconcileOneHandle(BOB_DID)
    expect(added).toBe(0)
    expect(
      useAuthStore.getState().subscriptions.map((s) => s.channelID),
    ).toEqual([ch2.channelID])
  })

  it('unfollowing sweeps all their feeds out and clears tombstones for a clean re-follow', async () => {
    const { ch1 } = await setup()
    useAuthStore.getState().addHandleFollow(BOB_DID)
    await reconcileOneHandle(BOB_DID)

    // Manually drop ch1 first (tombstone), so the sweep exercises both the
    // held channel (ch2) and the already-dropped one (ch1).
    useAuthStore.getState().removeSubscription(ch1.channelID)

    useAuthStore.getState().removeHandleFollow(BOB_DID)
    const removed = await sweepHandleFollow(BOB_DID)

    // Only ch2 was still held, so 1 removed; both feeds now gone.
    expect(removed).toBe(1)
    expect(useAuthStore.getState().subscriptions).toHaveLength(0)
    // Clean slate: neither channel is tombstoned, so re-following re-adds both.
    const dismissed = useAuthStore.getState().dismissedAutoWatch
    expect(dismissed).not.toContain(ch1.channelID)

    useAuthStore.getState().addHandleFollow(BOB_DID)
    const readded = await reconcileOneHandle(BOB_DID)
    expect(readded).toBe(2)
  })
})
