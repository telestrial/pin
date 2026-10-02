// A channel you do not hold, opened to look at.
//
// Until now, arriving at a channel page meant you had already watched it — which is why
// the page only ever offered to un-watch. The crawl changed that: a search hit names a
// public channel and carries its K, and so does a card on somebody's profile, so you can
// land on a channel with no relationship to it at all.
//
// The key is what makes that readable, and it travels on the navigation rather than in any
// store: nothing persists a channel you are merely looking at. So these cover the rung the
// page grew — resolve with the key in hand — and the negative that says the key is doing
// the work.

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)
vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)

import userEvent from '@testing-library/user-event'
import {
  directory_collection,
  tally_collection,
  tally_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ChannelView } from '../components/channel/ChannelView'
import { channelKeyFromBase64 } from '../core/crypto'
import type { ChannelManifest, ItemRef } from '../core/types'
import { startWatching } from '../lib/watch'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { didOfSync, fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

/** The AppKey their channel is sealed under. */
const THEIR_APP_KEY = '22'.repeat(32)

// Their real did, which their channel's manifest is signed by and the page checks it against.
// Set once the wasm is up, which the int tier's setup does first.
let THEM = ''
beforeAll(() => {
  THEM = didOfSync(THEIR_APP_KEY)
})
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const CHANNEL = 'theirchannel0001'

function post(body: string, publishedAt: string): ItemRef {
  return {
    id: `id-${body}`,
    itemURL: `sia://${body}`,
    type: 'text',
    title: '',
    summary: body,
    publishedAt,
    mimeType: 'text/markdown',
    byteSize: 32,
  } as ItemRef
}

function manifest(
  name: string,
  items: ItemRef[],
  visibility = 'public',
): ChannelManifest {
  return {
    version: 1,
    name,
    description: 'theirs',
    authorPubkey: 'ed25519:aa',
    authorDidDht: THEM,
    publishedAt: '2026-09-01T00:00:00.000Z',
    visibility,
    items,
  } as ChannelManifest
}

/** What their channel currently publishes, behind the locator K derives. */
async function published(items: ItemRef[], visibility = 'public') {
  const { publishLocator } = await import('../lib/channelLocatorNative')
  await publishLocator(
    THEIR_APP_KEY,
    channelKeyFromBase64(KEY),
    JSON.stringify(manifest('Their channel', items, visibility)),
  )
}

/** A held directory record whose author follows this channel — the corpus a follower
 *  scan reads, and the only place a follower can be learned from. */
function holdFollower(didDht: string) {
  docStore.set(
    `${directory_collection()}/${didDht}`,
    new TextEncoder().encode(
      JSON.stringify({
        tier: 'full',
        profile: { username: didDht, displayName: didDht },
        channels: [],
        reach: [],
        follows: [{ didDht: THEM, channelID: CHANNEL }],
        handleFollows: [],
        url: 'sia://held',
        epoch: 1,
        seenAt: '2026-09-01T12:00:00.000Z',
      }),
    ),
  )
}

/** The number a `Stat` is showing, by the label under it.
 *
 *  Found by SHAPE — a number (or the uncounted dash) directly above the label — because
 *  the same word is also a section heading further down the page. */
function stat(label: string): string {
  for (const el of screen.getAllByText(label)) {
    const n = el.previousElementSibling?.textContent ?? ''
    if (/^(\d+|—)$/.test(n)) return n
  }
  return ''
}

function view(channelKey?: string) {
  return render(
    <ChannelView
      authorHandle=""
      channelID={CHANNEL}
      channelKey={channelKey}
      authorDid={THEM}
      onItemClick={() => {}}
      onChannelClick={() => {}}
      onHandleClick={() => {}}
      onBack={() => {}}
      sidebar={null}
      rightSidebar={null}
    />,
  )
}

describe('integration: browsing a channel you do not hold', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('reads it with the key the navigation carried', async () => {
    await published([post('something they wrote', '2026-09-02T00:00:00.000Z')])

    view(KEY)

    await waitFor(() =>
      expect(screen.getByText('something they wrote')).toBeInTheDocument(),
    )
    // The description comes from the MANIFEST and from nowhere else — no settings entry,
    // no directory row carries one — so it could only have come from the resolve. Nothing
    // local knows this channel at all.
    expect(screen.getByText('theirs')).toBeInTheDocument()
  })

  it('reads nothing without one', async () => {
    // The negative that makes the above mean something: the same page, the same published
    // channel, and no key. K both locates and decrypts, so without it there is not even a
    // locator to resolve — which is the property that keeps an unlisted channel unlisted,
    // seen from the reader's side.
    await published([post('something they wrote', '2026-09-02T00:00:00.000Z')])

    view(undefined)

    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('something they wrote')).toBeNull()
  })

  it('counts the channel followers it holds, and you among them', async () => {
    // Two followers from the two halves the corpus has: a held record that names the
    // channel, and your own local edge, which is never in the index because the crawl
    // does not read you.
    await published([post('a post', '2026-09-02T00:00:00.000Z')])
    holdFollower('did:dht:someone')
    useAuthStore.setState({
      myDidDht: 'did:dht:me',
      follows: [{ didDht: THEM, channelID: CHANNEL }],
    })

    view(KEY)

    await waitFor(() => expect(stat('Followers')).toBe('2'))
  })

  it('does not count the wholesale followers of its author', async () => {
    // One to one: following a person is following the person, and counts on their profile.
    // A channel's number is the people who followed the channel.
    await published([post('a post', '2026-09-02T00:00:00.000Z')])
    docStore.set(
      `${directory_collection()}/did:dht:fan`,
      new TextEncoder().encode(
        JSON.stringify({
          tier: 'full',
          profile: { username: 'fan', displayName: 'fan' },
          channels: [],
          reach: [],
          follows: [],
          handleFollows: [THEM],
          url: 'sia://held',
          epoch: 1,
          seenAt: '2026-09-01T12:00:00.000Z',
        }),
      ),
    )

    view(KEY)

    await waitFor(() => expect(stat('Followers')).toBe('0'))
  })

  it("shows the author's published count, and says the list is what you know of", async () => {
    // The author holds follows from people this device has never read — they arrived by
    // knock — so the number is their tally and the list is the part of it visible here.
    await published([post('a post', '2026-09-02T00:00:00.000Z')])
    holdFollower('did:dht:direct')
    docStore.set(
      `${tally_collection()}/${tally_rkey(CHANNEL, CHANNEL)}`,
      new TextEncoder().encode(
        JSON.stringify({
          kinds: {
            follow: { count: 5, setRoot: 'root', sampleActors: [THEM] },
          },
          updatedAt: '2026-09-28T00:00:00.000Z',
        }),
      ),
    )

    view(KEY)

    await waitFor(() => expect(stat('Followers')).toBe('5'))
    await userEvent.click(screen.getByRole('button', { name: /Followers/ }))
    const list = within(screen.getByRole('region', { name: 'Followers' }))
    expect(list.getByText('The 1 you know of')).toBeInTheDocument()
  })

  it('recounts when the crawl records a follower after the page opened', async () => {
    // Following somebody reads them a moment AFTER the press, so a count taken at the
    // press has only what was held then. The record landing is what has to move it.
    await published([post('a post', '2026-09-02T00:00:00.000Z')])
    holdFollower('did:dht:first')

    view(KEY)
    await waitFor(() => expect(stat('Followers')).toBe('1'))

    const { putRecord } = await import('../lib/docs')
    await act(() =>
      putRecord(
        directory_collection(),
        'did:dht:later',
        new TextEncoder().encode(
          JSON.stringify({
            tier: 'full',
            profile: null,
            channels: [],
            reach: [],
            follows: [{ didDht: THEM, channelID: CHANNEL }],
            handleFollows: [],
            url: 'sia://held',
            epoch: 1,
            seenAt: '2026-09-01T12:00:00.000Z',
          }),
        ),
      ),
    )
    await waitFor(() => expect(stat('Followers')).toBe('2'))
  })

  it('opens the list behind the number', async () => {
    // Folded away until asked for, because the page body is the channel's feed. The
    // channel's own followers only — somebody following its author is not among them.
    await published([post('a post', '2026-09-02T00:00:00.000Z')])
    holdFollower('did:dht:direct')
    docStore.set(
      `${directory_collection()}/did:dht:fan`,
      new TextEncoder().encode(
        JSON.stringify({
          tier: 'full',
          profile: { username: 'fan', displayName: 'fan' },
          channels: [],
          reach: [],
          follows: [],
          handleFollows: [THEM],
          url: 'sia://held',
          epoch: 1,
          seenAt: '2026-09-01T12:00:00.000Z',
        }),
      ),
    )

    view(KEY)

    await waitFor(() => expect(stat('Followers')).toBe('1'))
    expect(screen.queryByRole('region', { name: 'Followers' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Followers/ }))

    const list = within(screen.getByRole('region', { name: 'Followers' }))
    expect(list.getAllByRole('button')).toHaveLength(1)
  })

  it('offers no follower count on an unlisted channel', async () => {
    // Not zero — absent. A `FollowEdge` carries no K and resolves through the author's
    // directory, where an unlisted channel is absent by construction, so the scan is
    // structurally empty forever and a number would state a fact about the channel where
    // the truth is that the relation does not apply. The same predicate hides Follow.
    await published([post('a post', '2026-09-02T00:00:00.000Z')], 'obscure')
    holdFollower('did:dht:someone')

    view(KEY)

    await waitFor(() => expect(screen.getByText('a post')).toBeInTheDocument())
    expect(screen.queryByText('Followers')).toBeNull()
  })

  it('leaves a channel you watch to the feed store', async () => {
    // The rung above. A watched channel is kept current by the pull loop and is already in
    // the store, so the page must not go resolving one — the ladder is preference-ordered,
    // and spending a DHT lookup and a Sia download for bytes already in hand is the thing
    // it exists to stop.
    useAuthStore.setState({
      subscriptions: [
        {
          authorHandle: '',
          authorDID: '',
          didDht: THEM,
          channelID: CHANNEL,
          channelKey: KEY,
          addedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    })
    useFeedStore.setState({
      manifests: {
        [CHANNEL]: manifest('From the store', [
          post('held already', '2026-09-03T00:00:00.000Z'),
        ]),
      },
    })
    // Nothing is published, so a resolve could not answer even if it were attempted.

    view(KEY)

    await waitFor(() =>
      expect(screen.getByText('From the store')).toBeInTheDocument(),
    )
  })
})

describe('integration: the relation you have with a channel', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('offers both relations on a public channel you have neither with', async () => {
    // The state that could not exist before: on a channel page, holding nothing. Both are
    // offered because both are available — public and private are a choice here, and the
    // page is where it gets made.
    await published([post('a post of theirs', '2026-09-02T00:00:00.000Z')])

    view(KEY)

    await waitFor(() => expect(screen.getByText('Watch')).toBeInTheDocument())
    expect(screen.getByText('Follow')).toBeInTheDocument()
  })

  it('offers only Watch on an unlisted one', async () => {
    // Absent rather than disabled. A FollowEdge carries no K and resolves through the
    // author's directory, where an unlisted channel is absent by construction — so there
    // is nothing to follow THROUGH, and a disabled button would imply a permission
    // somebody could be granted.
    await published(
      [post('a post of theirs', '2026-09-02T00:00:00.000Z')],
      'obscure',
    )

    view(KEY)

    await waitFor(() => expect(screen.getByText('Watch')).toBeInTheDocument())
    expect(screen.queryByText('Follow')).toBeNull()
  })

  it('starts watching from the key in hand, with no second fetch', async () => {
    await published([post('a post of theirs', '2026-09-02T00:00:00.000Z')])
    view(KEY)
    await waitFor(() => screen.getByText('Watch'))

    await userEvent.click(screen.getByText('Watch'))

    await waitFor(() =>
      expect(
        useAuthStore.getState().subscriptions.map((s) => s.channelID),
      ).toEqual([CHANNEL]),
    )
    // The page still shows the channel after the toggle. Deliberately NOT a claim about
    // WHERE those bytes came from: the page's own cold-mount refresh would put them there
    // too, a round trip later, so this cannot tell seeding apart from it. What seeding
    // guarantees is covered directly below.
  })

  it('hides Watch once you follow, because following already watches', async () => {
    // Three states, not two toggles. Watching beside Following would name a fourth that
    // does not exist — and a user who unticked it would be asking to follow publicly
    // while not reading, which the mechanism cannot do.
    await published([post('a post of theirs', '2026-09-02T00:00:00.000Z')])
    useAuthStore.setState({
      follows: [{ didDht: THEM, channelID: CHANNEL, name: 'Their channel' }],
    })

    view(KEY)

    await waitFor(() =>
      expect(screen.getByText('Following')).toBeInTheDocument(),
    )
    expect(screen.queryByText('Watch')).toBeNull()
    expect(screen.queryByText('Watching')).toBeNull()
  })
})

describe('starting a watch seeds what the page falls back to', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })

  it('records the channel and its posts from the manifest in hand', async () => {
    // The moment a watch starts, the page reading that channel stops being the browsed
    // one and becomes the store-backed one. If the store has nothing, that page is blank
    // until a refresh lands — for bytes that were already on screen.
    //
    // Tested here rather than through the UI because a rendered page cannot tell this
    // apart from the refresh that follows it: both end with the posts showing, and only
    // one of them does it without a round trip.
    const m = manifest('Their channel', [
      post('already in hand', '2026-09-02T00:00:00.000Z'),
    ])

    await startWatching({
      authorHandle: '',
      didDht: THEM,
      channelID: CHANNEL,
      channelKey: KEY,
      manifest: m,
    })

    expect(
      useAuthStore.getState().subscriptions.map((x) => x.channelID),
    ).toEqual([CHANNEL])
    expect(useFeedStore.getState().manifests[CHANNEL]).toEqual(m)
    expect(useFeedStore.getState().entries.map((e) => e.item.summary)).toEqual([
      'already in hand',
    ])
  })
})
