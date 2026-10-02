// The channels this identity reads: watches, plus each followed person's profile feed.
//
// The set itself is the Curator's function (`pin_curator::reading`, tested in Rust); what
// these cover is the frontend's half of the seam — that the crawl's record reaches it, that
// a watch comes back as itself, and that the feed follows the set as it moves without
// dropping anything on a reading nobody has made yet.

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)
vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)

import { directory_collection } from '../../crates/pin-core/pkg/pin_core.js'
import { HomeFeed } from '../components/HomeFeed'
import type { SubscriptionRef } from '../core/types'
import { putRecord } from '../lib/docs'
import { useReading } from '../lib/hooks/useReading'
import { computeReading } from '../lib/reading'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { useReadingStore } from '../stores/reading'
import { fakeDocStore as docStore } from './fakeModules'
import {
  authorCreateChannel,
  createFakeApp,
  FAKE_APP_KEY_HEX,
  mountAs,
  publishTextPost,
  resetAllStores,
} from './setupFakeApp'

const ALICE = 'did:dht:alice'
const BOB = 'did:dht:bob'

const WATCH: SubscriptionRef = {
  authorHandle: '',
  authorDID: '',
  didDht: 'did:dht:someone',
  channelID: 'watched',
  channelKey: 'KW',
  addedAt: '2026-09-01T00:00:00.000Z',
}

/** A directory record as the crawl writes one — no `tier`, which the Rust side reads as
 *  full, exactly as every record written before tiers existed. */
function directory(channels: unknown[]) {
  return { profile: null, channels, reach: [], follows: [], handleFollows: [] }
}

async function hold(did: string, value: unknown) {
  await putRecord(
    directory_collection(),
    did,
    new TextEncoder().encode(JSON.stringify(value)),
  )
}

afterEach(cleanup)

// The hook tests below stub these two; `reset` restores data, not actions.
const { refreshChannel: realRefresh, removeChannel: realRemove } =
  useFeedStore.getState()

beforeEach(() => {
  resetAllStores()
  docStore.clear()
  useFeedStore.setState({
    refreshChannel: realRefresh,
    removeChannel: realRemove,
  })
})

describe('the home feed', () => {
  it("shows a followed person's post with nothing watched", async () => {
    // Following a person copies nothing into the watches, so this post has one route to
    // the screen: the crawl's record of alice, through the read set, into the feed. The
    // feed's first load runs on the watches alone — empty — before the set is computed,
    // so the post arriving at all is the set being read in after the fact.
    const app = createFakeApp()
    const alice = app.createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    const bob = app.createAccount({ did: 'did:plc:bob', handle: 'bob.test' })
    const channel = await authorCreateChannel(alice, { name: "Alice's voice" })
    await publishTextPost(
      alice,
      { channelID: channel.channelID, channelKey: channel.channelKey },
      'hello to followers',
    )

    mountAs(bob)
    useAuthStore.setState({ handleFollows: [alice.didDht] })
    await hold(
      alice.didDht,
      directory([
        {
          channelID: channel.channelID,
          key: channel.channelKey,
          name: "Alice's voice",
        },
      ]),
    )

    function Home() {
      useReading()
      return (
        <HomeFeed
          onItemClick={() => {}}
          onChannelClick={() => {}}
          onHandleClick={() => {}}
        />
      )
    }
    render(<Home />)

    await waitFor(() =>
      expect(screen.getByText('hello to followers')).toBeInTheDocument(),
    )

    // Refresh rebuilds the whole feed from the list it is given, so a feed that still
    // rebuilt from the watches alone would drop every followed person's post here.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(useFeedStore.getState().loading).toBe(false))
    expect(screen.getByText('hello to followers')).toBeInTheDocument()
  })
})

describe('computeReading', () => {
  it('adds what a followed person shows on their profile, and keeps a watch as itself', async () => {
    await hold(
      ALICE,
      directory([
        { channelID: 'a1', key: 'K1', name: 'One' },
        { channelID: 'a2', key: 'K2', name: 'Off', showOnProfile: false },
      ]),
    )

    const r = await computeReading(FAKE_APP_KEY_HEX, [WATCH], [ALICE])

    expect(r.channels.map((c) => c.channelID)).toEqual(['watched', 'a1'])
    expect(r.channels[0]).toBe(WATCH)
    expect(r.channels[1]).toMatchObject({
      didDht: ALICE,
      channelKey: 'K1',
      cachedName: 'One',
    })
    expect(r.unsettled).toEqual([])
  })

  it('reports a followed person the crawl has not read as unsettled', async () => {
    const r = await computeReading(FAKE_APP_KEY_HEX, [], [ALICE])
    expect(r.channels).toEqual([])
    expect(r.unsettled).toEqual([ALICE])
  })
})

describe('useReading', () => {
  const refreshChannel = vi.fn(async (_: SubscriptionRef) => {})
  const removeChannel = vi.fn((_: string) => {})

  beforeEach(() => {
    refreshChannel.mockClear()
    removeChannel.mockClear()
    useFeedStore.setState({ refreshChannel, removeChannel })
    useAuthStore.setState({ storedKeyHex: FAKE_APP_KEY_HEX })
  })

  it('reads a followed person into the feed once the crawl records them, and out on unfollow', async () => {
    useAuthStore.setState({ handleFollows: [ALICE] })
    renderHook(() => useReading())
    await waitFor(() => expect(useReadingStore.getState().channels).toEqual([]))

    // The crawl reads alice: her channel joins the set, and the feed reads it in.
    await act(() =>
      hold(ALICE, directory([{ channelID: 'a1', key: 'K1', name: 'One' }])),
    )
    await waitFor(() =>
      expect(refreshChannel).toHaveBeenCalledWith(
        expect.objectContaining({ channelID: 'a1' }),
      ),
    )

    act(() => useAuthStore.setState({ handleFollows: [] }))
    await waitFor(() => expect(removeChannel).toHaveBeenCalledWith('a1'))
  })

  it("keeps an unsettled author's channels, and only theirs", async () => {
    await hold(ALICE, directory([{ channelID: 'a1', key: 'K1', name: 'One' }]))
    useAuthStore.setState({ handleFollows: [ALICE, BOB] })
    renderHook(() => useReading())
    await waitFor(() =>
      expect(
        useReadingStore.getState().channels?.map((c) => c.channelID),
      ).toEqual(['a1']),
    )

    // Alice's record fades: her channels are now missing for want of a reading, so the
    // feed keeps what it has of hers.
    await act(() => hold(ALICE, { ...directory([]), tier: 'reduced' }))
    await waitFor(() => expect(useReadingStore.getState().channels).toEqual([]))
    expect(removeChannel).not.toHaveBeenCalled()

    // Bob being unread says nothing about somebody else's channel: a followed person shows
    // only their own. Unfollowing alice takes hers out although bob is still unsettled.
    await act(() =>
      hold(ALICE, directory([{ channelID: 'a1', key: 'K1', name: 'One' }])),
    )
    await waitFor(() =>
      expect(
        useReadingStore.getState().channels?.map((c) => c.channelID),
      ).toEqual(['a1']),
    )
    act(() => useAuthStore.setState({ handleFollows: [BOB] }))
    await waitFor(() => expect(removeChannel).toHaveBeenCalledWith('a1'))
  })
})
