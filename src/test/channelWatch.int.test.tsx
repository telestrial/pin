// Following a channel watches it; following a person watches nothing.
//
// A channel-follow resolves its K from the author's directory (resolveIdentityDoc, mocked
// here) and keeps the one channel. A person-follow is the edge alone: their profile feed is
// read out of the crawl's record of them (reading.int.test.tsx), so nothing is copied into
// the watches and nothing has to be swept back out.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
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

import { FollowHandleButton } from '../components/FollowHandleButton'
import type { CreatedChannel } from '../core/channels'
import { unwatchOneChannel, watchOneChannel } from '../lib/channelWatch'
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

// bob publishes two public channels, registered in the mock identity-doc under his DID
// so a channel-follow can resolve its K; alice is signed in and watches nothing.
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

afterEach(cleanup)

describe('channel watch', () => {
  it('following one channel watches that channel and no others', async () => {
    const { ch1, ch2 } = await setup()

    const watched = await watchOneChannel(BOB_DID, ch1.channelID)

    expect(watched).toBe(true)
    const subs = useAuthStore.getState().subscriptions
    expect(subs.map((s) => s.channelID)).toEqual([ch1.channelID])
    expect(subs[0]?.channelKey).toBe(ch1.channelKey)
    expect(subs.some((s) => s.channelID === ch2.channelID)).toBe(false)
  })

  it('unfollowing a channel drops the watch, and following it again brings it back', async () => {
    const { ch1 } = await setup()
    await watchOneChannel(BOB_DID, ch1.channelID)

    expect(await unwatchOneChannel(ch1.channelID)).toBe(true)
    expect(useAuthStore.getState().subscriptions).toEqual([])

    expect(await watchOneChannel(BOB_DID, ch1.channelID)).toBe(true)
    expect(
      useAuthStore.getState().subscriptions.map((s) => s.channelID),
    ).toEqual([ch1.channelID])
  })

  it('following a person records the edge and watches nothing', async () => {
    await setup()
    render(<FollowHandleButton subjectDidDht={BOB_DID} subjectHandle="bob" />)

    fireEvent.click(screen.getByRole('button', { name: 'Follow' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Following' })).toBeEnabled(),
    )

    expect(useAuthStore.getState().handleFollows).toEqual([BOB_DID])
    expect(useAuthStore.getState().subscriptions).toEqual([])
  })
})
