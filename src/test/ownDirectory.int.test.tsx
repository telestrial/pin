// Your own profile page, which is assembled rather than resolved.
//
// Everything a directory carries is something this process already holds — the profile, the
// advertised set and the follows are settings, and each manifest is in the doc. Resolving
// your own did:dht spends a DHT lookup and a Sia download to be told what you wrote, and
// answers with what was last PUBLISHED, so a channel created a minute ago is missing from
// your own profile until the identity loop's next pass.
//
// Somebody ELSE's still resolves, because for them there is no local answer — which is the
// asymmetry this locks, in both directions.

import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

// The channel round-trip, so a hero card's manifest can be put in the doc cache and NOT
// on the network — which is what tells the two rungs apart.
vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)

const resolveIdentityDoc = vi.fn()
vi.mock('../lib/identityDoc', () => ({
  resolveIdentityDoc: (...args: unknown[]) => resolveIdentityDoc(...args),
}))

import {
  directory_collection,
  request_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
import { HandleDirectory } from '../components/HandleDirectory'
import { channelKeyFromBase64, encryptForChannel } from '../core/crypto'
import type { ChannelManifest, ItemRef, OwnedChannel } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const ME = 'did:dht:me'
const THEM = 'did:dht:them'
// 32 bytes of base64, the shape a channel key travels in.
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
// A second channel key, so two channels on one profile resolve to two different
// manifests rather than sharing one locator.
const KEY2 = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8='

function manifest(name: string, items: ItemRef[] = []): ChannelManifest {
  return {
    version: 1,
    name,
    description: 'from the doc',
    authorPubkey: 'ed25519:aa',
    authorDidDht: ME,
    publishedAt: '2026-08-27T12:00:00.000Z',
    visibility: 'public',
    items,
  } as ChannelManifest
}

/** A post, identified the way the rest of the system identifies one. */
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

/** Put an owned channel's manifest where the commit that publishes one puts it. */
async function inTheDoc(
  channelID: string,
  name: string,
  items: ItemRef[] = [],
  key = KEY,
) {
  const sealed = await encryptForChannel(
    channelKeyFromBase64(key),
    JSON.stringify(manifest(name, items)),
  )
  docStore.set(`channel/${channelID}`, new TextEncoder().encode(sealed))
}

/** Put a channel's manifest where the pull loop caches a SUBSCRIBED one. Sealed under K
 *  for real, so the read under test decodes it exactly as it decodes a cached resolve. */
async function inTheCache(
  channelID: string,
  name: string,
  items: ItemRef[] = [],
  key = KEY,
) {
  const sealed = await encryptForChannel(
    channelKeyFromBase64(key),
    JSON.stringify(manifest(name, items)),
  )
  docStore.set(`sub/${channelID}`, new TextEncoder().encode(sealed))
}

function owned(over: Partial<OwnedChannel> = {}): OwnedChannel {
  return {
    channelID: 'chan1',
    channelKey: KEY,
    name: 'A channel',
    createdAt: '2026-08-27T11:00:00.000Z',
    visibility: 'public',
    ...over,
  }
}

function signedInWith(myChannels: OwnedChannel[]) {
  mountAs(
    createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
  )
  useAuthStore.setState({
    myDidDht: ME,
    myChannels,
    follows: [],
    profile: {
      $type: 'dev.sia.pin.profile',
      username: 'me',
      displayName: 'Me',
      updatedAt: '2026-08-27T10:00:00.000Z',
    },
  })
}

/** A directory record the crawl has read, at the tier it still holds them. */
function hold(
  didDht: string,
  displayName: string,
  tier = 'full',
  channels: {
    channelID: string
    key: string
    name: string
    showOnProfile?: boolean
  }[] = [],
) {
  docStore.set(
    `${directory_collection()}/${didDht}`,
    new TextEncoder().encode(
      JSON.stringify({
        tier,
        profile:
          tier === 'full' ? { username: displayName, displayName } : null,
        channels,
        reach: [],
        follows: [],
        handleFollows: [],
        url: 'sia://held',
        epoch: 1,
        seenAt: '2026-09-01T12:00:00.000Z',
      }),
    ),
  )
}

/** What they currently publish, as the revalidation finds it.
 *
 *  Deliberately missing `handleFollows`: the resolve casts raw JSON from somebody else's
 *  blob, so a field they do not carry arrives undefined. A fixture that filled in every
 *  field would hide exactly that. */
function published(displayName: string) {
  return {
    profile: { username: displayName, displayName },
    channels: [],
    follows: [],
  }
}

/** A held record whose author follows things, which is the corpus a follower scan reads. */
function holdFollowing(
  didDht: string,
  edges: {
    follows?: { didDht: string; channelID: string }[]
    handleFollows?: string[]
  },
) {
  docStore.set(
    `${directory_collection()}/${didDht}`,
    new TextEncoder().encode(
      JSON.stringify({
        tier: 'full',
        profile: { username: didDht, displayName: didDht },
        channels: [],
        reach: [],
        follows: edges.follows ?? [],
        handleFollows: edges.handleFollows ?? [],
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

function directory(handle: string, onCreate?: () => void) {
  return (
    <HandleDirectory
      handle={handle}
      onItemClick={() => {}}
      onChannelClick={() => {}}
      onHandleClick={() => {}}
      onCreate={onCreate}
      sidebar={<aside />}
      rightSidebar={<aside />}
    />
  )
}

describe('integration: your own directory comes from local state', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    resolveIdentityDoc.mockReset()
    resolveIdentityDoc.mockResolvedValue(null)
  })

  it('renders your channels without resolving anything', async () => {
    signedInWith([owned()])
    await inTheDoc('chan1', 'A channel')

    render(directory(ME))

    await waitFor(() => {
      expect(screen.getByText('A channel')).toBeInTheDocument()
    })
    // The description proves it came out of the MANIFEST rather than off the settings
    // entry, which carries a name and nothing else.
    expect(screen.getByText('from the doc')).toBeInTheDocument()
    expect(resolveIdentityDoc).not.toHaveBeenCalled()
  })

  it('shows only what the directory would advertise', async () => {
    // The published set and the local one have to agree, or your own profile tells you
    // something about your reach that isn't true. Unlisted is the half that matters most:
    // it is absent from the directory by construction, and a page that listed it would be
    // the only place claiming otherwise.
    signedInWith([
      owned(),
      owned({ channelID: 'chan2', name: 'Unclaimed', advertised: false }),
      owned({ channelID: 'chan3', name: 'Unlisted', visibility: 'obscure' }),
      owned({ channelID: 'chan4', name: 'Older', visibility: undefined }),
    ])
    await inTheDoc('chan1', 'A channel')
    await inTheDoc('chan2', 'Unclaimed')
    await inTheDoc('chan3', 'Unlisted')
    await inTheDoc('chan4', 'Older')

    render(directory(ME))

    await waitFor(() => {
      expect(screen.getByText('A channel')).toBeInTheDocument()
    })
    expect(screen.queryByText('Unclaimed')).toBeNull()
    expect(screen.queryByText('Unlisted')).toBeNull()
    // Visibility absent means UNKNOWN, and unknown is never advertised — the rule that
    // stops a channel written before the field existed being enumerated on a guess.
    expect(screen.queryByText('Older')).toBeNull()
  })

  it('leaves your own channels out of your Following', async () => {
    // An author follows their own channel so it counts toward the CHANNEL. That claim is
    // about the voice; reading it as attention would show a profile following N people
    // while it follows nobody but itself. One follow of somebody else, one of your own —
    // the count is 1 and the list names only theirs.
    signedInWith([owned()])
    useAuthStore.setState({
      follows: [
        { didDht: ME, channelID: 'chan1', name: 'My own voice' },
        { didDht: THEM, channelID: 'ch-theirs', name: 'Their voice' },
      ],
    })
    await inTheDoc('chan1', 'A channel')

    render(directory(ME))

    await waitFor(() => {
      expect(screen.getByText('Their voice')).toBeInTheDocument()
    })
    expect(stat('Following')).toBe('1')
    expect(screen.queryByText('My own voice')).toBeNull()
  })

  it('counts YOUR OWN follow toward their followers, beside the held ones', async () => {
    // The corpus is the held `directory/<did>` records and there is never one for you —
    // both crawlers skip your own did on purpose. So without your local edges unioned in,
    // every count you read is short by exactly yourself, on every subject you follow.
    //
    // Two followers, one from each half: a held record that names them, and you. A
    // sabotage of either half reads 1 rather than 2.
    signedInWith([])
    useAuthStore.setState({ handleFollows: [THEM] })
    hold(THEM, 'them')
    holdFollowing('did:dht:someone', { handleFollows: [THEM] })

    render(directory(THEM))

    await waitFor(() => {
      expect(stat('Followers')).toBe('2')
    })
  })

  it('does not credit a person with the followers of their channels', async () => {
    // One to one: somebody who followed one channel followed the channel, and counts on
    // its page rather than on its author's.
    signedInWith([])
    hold(THEM, 'them')
    holdFollowing('did:dht:someone', {
      follows: [{ didDht: THEM, channelID: 'their-techno' }],
    })

    render(directory(THEM))

    await waitFor(() => {
      expect(stat('Followers')).toBe('0')
    })
  })

  it('lists who follows them, and the count is that list', async () => {
    // A wholesale follower is listed; a follower of one channel is not.
    signedInWith([owned()])
    await inTheDoc('chan1', 'A channel')
    holdFollowing('did:dht:fan-of-one', {
      follows: [{ didDht: ME, channelID: 'chan1' }],
    })
    holdFollowing('did:dht:fan-of-all', { handleFollows: [ME] })

    render(directory(ME))

    const followersHeading = await screen.findByRole('heading', {
      name: 'Followers',
    })
    const section = within(followersHeading.parentElement as HTMLElement)
    expect(section.getAllByRole('button')).toHaveLength(1)
    expect(stat('Followers')).toBe('1')
  })

  it('lists and counts each follow as what it is', async () => {
    // Two channels of one person, and that person wholesale: three follows, three rows.
    signedInWith([owned()])
    useAuthStore.setState({
      follows: [
        { didDht: THEM, channelID: 'ch-techno', name: 'Techno' },
        { didDht: THEM, channelID: 'ch-cats', name: 'Cats' },
      ],
      handleFollows: [THEM],
    })
    await inTheDoc('chan1', 'A channel')

    render(directory(ME))

    await waitFor(() => {
      expect(screen.getByText('Techno')).toBeInTheDocument()
    })
    expect(screen.getByText('Cats')).toBeInTheDocument()
    expect(stat('Following')).toBe('3')
  })

  it('renders a held profile before the network has answered', async () => {
    // The landing costs a doc read rather than a DHT lookup and a Sia download, which is
    // the whole of what the crawl's index buys a page. Holding the resolve open is what
    // makes the assertion about ORDER rather than about the eventual answer.
    signedInWith([owned()])
    hold(THEM, 'from-the-index')
    let answer: (doc: unknown) => void = () => {}
    resolveIdentityDoc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText('from-the-index')).toBeInTheDocument(),
    )
    answer(published('from-the-network'))
  })

  it('goes out and looks even when the index answered', async () => {
    // What landing MEANS. The index is only ever as fresh as the crawl's last pass, so a
    // rename or a new channel reaches this page only if it asks.
    signedInWith([owned()])
    hold(THEM, 'from-the-index')
    resolveIdentityDoc.mockResolvedValue(published('from-the-network'))

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText('from-the-network')).toBeInTheDocument(),
    )
    expect(resolveIdentityDoc).toHaveBeenCalled()
  })

  it('keeps a rendered page when the revalidation cannot answer', async () => {
    // A resolve that failed says nothing about whether this identity exists. Replacing a
    // page that rendered with "that identity doesn't resolve" is an inability to read
    // converted into a decision — the shape this codebase has paid for three times.
    signedInWith([owned()])
    hold(THEM, 'from-the-index')
    resolveIdentityDoc.mockResolvedValue(null)

    render(directory(THEM))

    await waitFor(() => expect(resolveIdentityDoc).toHaveBeenCalled())
    expect(screen.getByText('from-the-index')).toBeInTheDocument()
    expect(screen.queryByText(/doesn't resolve/)).toBeNull()
  })

  it('reports an identity it could reach on neither rung as not found', async () => {
    // The other direction, and the reason the one above is a guard rather than a blanket
    // refusal to ever say not-found: with nothing rendered there is no page to protect.
    signedInWith([owned()])
    resolveIdentityDoc.mockResolvedValue(null)

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText(/doesn't resolve/)).toBeInTheDocument(),
    )
  })

  it('asks the crawl for somebody the index could not render', async () => {
    // A faded record dropped its profile and channels to make room, so rendering from one
    // would show a person with no name and no work. That is a miss, and a miss is what a
    // request is for.
    signedInWith([owned()])
    hold(THEM, '', 'reduced')
    resolveIdentityDoc.mockResolvedValue(published('from-the-network'))

    render(directory(THEM))

    await waitFor(() =>
      expect(docStore.has(`${request_collection()}/${THEM}`)).toBe(true),
    )
  })

  it('asks for nobody it could render from the index', async () => {
    // A page that rendered from a full record is holding the fresh answer already, and
    // the crawl keeps a full record current on its own rotation. Asking on every landing
    // would spend the refresh budget on people whose answer is already on screen.
    signedInWith([owned()])
    hold(THEM, 'from-the-index')
    resolveIdentityDoc.mockResolvedValue(published('from-the-network'))

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText('from-the-network')).toBeInTheDocument(),
    )
    expect(docStore.has(`${request_collection()}/${THEM}`)).toBe(false)
  })

  it('counts people and channels as one Following', async () => {
    // Following a person and following one of their channels are one act at two grains,
    // and both are public edges the crawl walks. Split across two numbers a profile would
    // report only half of what somebody follows — which is what it did, since the people
    // half was published from the day it shipped and displayed nowhere.
    signedInWith([owned()])
    resolveIdentityDoc.mockResolvedValue({
      profile: { username: 'them', displayName: 'Them' },
      channels: [],
      follows: [{ didDht: 'did:dht:x', channelID: 'c1', name: 'A channel' }],
      handleFollows: ['did:dht:y', 'did:dht:z'],
    })

    render(directory(THEM))

    // One channel plus two people. The number is the claim — "Following" itself
    // appears twice on the page, as the stat's label and the section's heading.
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument())
  })

  it('renders a profile whose blob carries no follow fields at all', async () => {
    // `resolveIdentityDoc` casts raw JSON, so every list field is whatever the blob holds.
    // Somebody who follows nobody is the ordinary case, and mapping over undefined would
    // take the whole page down rather than showing a person with no follows.
    signedInWith([owned()])
    resolveIdentityDoc.mockResolvedValue({
      profile: { username: 'them', displayName: 'Them' },
      channels: [],
    })

    render(directory(THEM))

    await waitFor(() => expect(screen.getByText('Them')).toBeInTheDocument())
    // The page stands rather than failing to render. The stat's label is unambiguous
    // here precisely BECAUSE they follow nobody: with no follows there is no Following
    // section to share the word with.
    expect(screen.getByText('Following')).toBeInTheDocument()
  })

  it('offers Create on your own profile with no channels to put beside it', async () => {
    // Create moved INTO the channel strip when the strip shrank, so it now renders on a
    // condition it did not used to share with anything. An author with no channels yet is
    // exactly who that affordance is for, and it is the case the move could drop.
    signedInWith([])

    render(directory(ME, () => {}))

    await waitFor(() => expect(screen.getByText('Create')).toBeInTheDocument())
  })

  it('offers nobody else a Create', async () => {
    // The other half. The strip renders for a stranger only when they have channels, so a
    // profile with neither is a header and nothing under it.
    signedInWith([owned()])
    resolveIdentityDoc.mockResolvedValue({
      profile: { username: 'them', displayName: 'Them' },
      channels: [],
      follows: [],
    })

    render(directory(THEM))

    await waitFor(() => expect(screen.getByText('Them')).toBeInTheDocument())
    expect(screen.queryByText('Create')).toBeNull()
  })

  it('still resolves somebody else', async () => {
    signedInWith([owned()])
    await inTheDoc('chan1', 'A channel')

    render(directory('did:dht:someoneelse'))

    await waitFor(() => {
      expect(resolveIdentityDoc).toHaveBeenCalled()
    })
    // And it does not quietly show them YOUR channels.
    expect(screen.queryByText('A channel')).toBeNull()
  })
})

describe("integration: somebody else's hero cards walk the resolution ladder", () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    resolveIdentityDoc.mockReset()
    resolveIdentityDoc.mockResolvedValue(null)
  })

  it('resolves a channel it holds nothing cached for', async () => {
    // The other rung, and the reason the one above is a preference rather than the only
    // path: a stranger's channel is in nobody's cache the first time.
    signedInWith([owned()])
    const { publishLocator } = await import('../lib/channelLocatorNative')
    await publishLocator(
      channelKeyFromBase64(KEY),
      JSON.stringify(manifest('Resolved channel')),
    )
    resolveIdentityDoc.mockResolvedValue({
      profile: { username: 'them', displayName: 'Them' },
      channels: [{ channelID: 'theirs', key: KEY, name: 'Resolved channel' }],
      follows: [],
    })

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText('Resolved channel')).toBeInTheDocument(),
    )
  })

  it('draws a card from the index before the directory resolves', async () => {
    // The crawl's record names each channel and carries its K, so a channel this device
    // already holds is a card for the price of a doc read — before any lookup. Holding the
    // resolve open is what makes this about ORDER rather than the eventual answer.
    signedInWith([owned()])
    await inTheCache('theirs', 'From the index')
    hold(THEM, 'them', 'full', [
      { channelID: 'theirs', key: KEY, name: 'Their channel' },
    ])
    let answer: (doc: unknown) => void = () => {}
    resolveIdentityDoc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText('From the index')).toBeInTheDocument(),
    )
    answer(null)
  })

  it('leaves a channel the index names but this device does not hold', async () => {
    // The record carries K but not the manifest, so a card it cannot answer from the doc
    // would cost a DHT lookup and a Sia download that the read below pays again. It waits
    // for the read that is happening anyway.
    signedInWith([owned()])
    hold(THEM, 'them', 'full', [
      { channelID: 'theirs', key: KEY, name: 'Their channel' },
    ])
    const { publishLocator } = await import('../lib/channelLocatorNative')
    await publishLocator(
      channelKeyFromBase64(KEY),
      JSON.stringify(manifest('Only from the network')),
    )
    let answer: (doc: unknown) => void = () => {}
    resolveIdentityDoc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )

    render(directory(THEM))

    await waitFor(() => expect(screen.getByText('them')).toBeInTheDocument())
    expect(screen.queryByText('Only from the network')).toBeNull()

    answer({
      profile: { username: 'them', displayName: 'them' },
      channels: [{ channelID: 'theirs', key: KEY, name: 'Their channel' }],
      follows: [],
    })
    await waitFor(() =>
      expect(screen.getByText('Only from the network')).toBeInTheDocument(),
    )
  })

  it('re-reads a channel it drew from the cache', async () => {
    // What landing means, for a card. `sub/` is only as fresh as the pull loop that fills
    // it, and the curation kill switch turns that loop off — its contract being that reads
    // still resolve on demand. A page that read the cache and stopped would be the one
    // place that stopped honouring it.
    signedInWith([owned()])
    await inTheCache('theirs', 'Stale name')
    const { publishLocator } = await import('../lib/channelLocatorNative')
    await publishLocator(
      channelKeyFromBase64(KEY),
      JSON.stringify(manifest('Current name')),
    )
    resolveIdentityDoc.mockResolvedValue({
      profile: { username: 'them', displayName: 'Them' },
      channels: [{ channelID: 'theirs', key: KEY, name: 'Their channel' }],
      follows: [],
    })

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText('Current name')).toBeInTheDocument(),
    )
    expect(screen.queryByText('Stale name')).toBeNull()
  })

  it('draws a cached card and keeps it when the re-read cannot answer', async () => {
    // Both halves of the rung the page used to skip. A channel you subscribe to is already
    // in the doc, so the card costs a doc read where it used to cost a DHT lookup and a
    // Sia download for the same bytes — and nothing publishes the locator here, so the
    // network CANNOT answer and the card on screen can be the cache's and nothing else.
    //
    // Then it stays. The network saying nothing is not the author saying the channel is
    // gone; dropping the card on a failed re-read would be an inability to read converted
    // into a decision.
    signedInWith([owned()])
    await inTheCache('theirs', 'From the cache')
    resolveIdentityDoc.mockResolvedValue({
      profile: { username: 'them', displayName: 'Them' },
      channels: [{ channelID: 'theirs', key: KEY, name: 'Their channel' }],
      follows: [],
    })

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText('From the cache')).toBeInTheDocument(),
    )
    // From the MANIFEST rather than the directory's name field, which carries a name and
    // nothing else — so this could not have come from the channel list alone.
    expect(screen.getByText('from the doc')).toBeInTheDocument()
    // Held PAST the re-read rather than only up to it.
    await waitFor(() => expect(resolveIdentityDoc).toHaveBeenCalled())
    expect(screen.getByText('From the cache')).toBeInTheDocument()
  })

  it('does not write a browsed channel into the subscribed cache', async () => {
    // `sub/` has one writer. The pull loop sweeps it down to the subscription set every
    // pass, so a stranger's manifest recorded here is deleted on the next one — the write
    // and the delete each re-mirroring the whole doc to Sia, to cache nothing.
    signedInWith([owned()])
    const { publishLocator } = await import('../lib/channelLocatorNative')
    await publishLocator(
      channelKeyFromBase64(KEY),
      JSON.stringify(manifest('Resolved channel')),
    )
    resolveIdentityDoc.mockResolvedValue({
      profile: { username: 'them', displayName: 'Them' },
      channels: [{ channelID: 'theirs', key: KEY, name: 'Resolved channel' }],
      follows: [],
    })

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText('Resolved channel')).toBeInTheDocument(),
    )
    expect(docStore.has('sub/theirs')).toBe(false)
  })
})

describe('integration: a profile is a feed of what its channels published', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    resolveIdentityDoc.mockReset()
    resolveIdentityDoc.mockResolvedValue(null)
  })

  it('merges your own included channels into one list', async () => {
    // One person, one feed. Which of their voices a post came from is a line on the row,
    // not a heading it sits under — a page that stacked a list per channel would still be
    // a directory rather than a profile.
    signedInWith([
      owned(),
      owned({ channelID: 'chan2', channelKey: KEY2, name: 'Second' }),
    ])
    await inTheDoc('chan1', 'A channel', [
      post('from the first', '2026-09-01T00:00:00.000Z'),
    ])
    await inTheDoc(
      'chan2',
      'Second',
      [post('from the second', '2026-09-02T00:00:00.000Z')],
      KEY2,
    )

    render(directory(ME))

    await waitFor(() =>
      expect(screen.getByText('from the first')).toBeInTheDocument(),
    )
    expect(screen.getByText('from the second')).toBeInTheDocument()
  })

  it('leaves out a channel you kept off your profile', async () => {
    // The flag's whole point, on the source that owns it: settings. The channel stays
    // advertised — findable and followable — and only its posts stop standing for you,
    // which is what makes this separate from `advertised`.
    signedInWith([
      owned(),
      owned({
        channelID: 'chan2',
        channelKey: KEY2,
        name: 'Kept off',
        showOnProfile: false,
      }),
    ])
    await inTheDoc('chan1', 'A channel', [
      post('on the profile', '2026-09-01T00:00:00.000Z'),
    ])
    await inTheDoc(
      'chan2',
      'Kept off',
      [post('off the profile', '2026-09-02T00:00:00.000Z')],
      KEY2,
    )

    render(directory(ME))

    await waitFor(() =>
      expect(screen.getByText('on the profile')).toBeInTheDocument(),
    )
    expect(screen.queryByText('off the profile')).toBeNull()
    // The channel itself is still listed — this is a feed decision, not a reach one.
    expect(screen.getByText('Kept off')).toBeInTheDocument()
  })

  it("honours somebody else's flag, which travels in their directory", async () => {
    // The published half. The author decides what stands for them, and a reader's page
    // has to read that decision off the blob rather than deciding for itself.
    signedInWith([owned()])
    const { publishLocator } = await import('../lib/channelLocatorNative')
    await publishLocator(
      channelKeyFromBase64(KEY),
      JSON.stringify(
        manifest('Shown', [post('theirs, shown', '2026-09-01T00:00:00.000Z')]),
      ),
    )
    await publishLocator(
      channelKeyFromBase64(KEY2),
      JSON.stringify(
        manifest('Hidden', [
          post('theirs, hidden', '2026-09-02T00:00:00.000Z'),
        ]),
      ),
    )
    resolveIdentityDoc.mockResolvedValue({
      profile: { username: 'them', displayName: 'Them' },
      channels: [
        { channelID: 'shown', key: KEY, name: 'Shown' },
        {
          channelID: 'hidden',
          key: KEY2,
          name: 'Hidden',
          showOnProfile: false,
        },
      ],
      follows: [],
    })

    render(directory(THEM))

    await waitFor(() =>
      expect(screen.getByText('theirs, shown')).toBeInTheDocument(),
    )
    expect(screen.queryByText('theirs, hidden')).toBeNull()
  })

  it('carries the flag on a card drawn from the crawl index', async () => {
    // The third source. A record the crawl holds names each channel and carries the flag
    // beside its K, so the page has to read it there too — rendering from the index and
    // deciding inclusion only after the resolve would show a post the author kept off
    // their profile for as long as the lookup takes.
    signedInWith([owned()])
    await inTheCache('hidden', 'Hidden', [
      post('held but kept off', '2026-09-02T00:00:00.000Z'),
    ])
    hold(THEM, 'them', 'full', [
      { channelID: 'hidden', key: KEY, name: 'Hidden', showOnProfile: false },
    ])
    let answer: (doc: unknown) => void = () => {}
    resolveIdentityDoc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )

    render(directory(THEM))

    await waitFor(() => expect(screen.getByText('them')).toBeInTheDocument())
    // The card is there — the channel is advertised — and its posts are not.
    expect(screen.getByText('Hidden')).toBeInTheDocument()
    expect(screen.queryByText('held but kept off')).toBeNull()
    answer(null)
  })
})
