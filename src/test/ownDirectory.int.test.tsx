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

import { render, screen, waitFor } from '@testing-library/react'
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
import type { ChannelManifest, OwnedChannel } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const ME = 'did:dht:me'
const THEM = 'did:dht:them'
// 32 bytes of base64, the shape a channel key travels in.
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

function manifest(name: string): ChannelManifest {
  return {
    version: 1,
    name,
    description: 'from the doc',
    authorPubkey: 'ed25519:aa',
    authorDidDht: ME,
    publishedAt: '2026-08-27T12:00:00.000Z',
    visibility: 'public',
    items: [],
  } as ChannelManifest
}

/** Put an owned channel's manifest where the commit that publishes one puts it. */
async function inTheDoc(channelID: string, name: string) {
  const sealed = await encryptForChannel(
    channelKeyFromBase64(KEY),
    JSON.stringify(manifest(name)),
  )
  docStore.set(`channel/${channelID}`, new TextEncoder().encode(sealed))
}

/** Put a channel's manifest where the pull loop caches a SUBSCRIBED one. Sealed under K
 *  for real, so the read under test decodes it exactly as it decodes a cached resolve. */
async function inTheCache(channelID: string, name: string) {
  const sealed = await encryptForChannel(
    channelKeyFromBase64(KEY),
    JSON.stringify(manifest(name)),
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
  channels: { channelID: string; key: string; name: string }[] = [],
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

/** What they currently publish, as the revalidation finds it. */
function published(displayName: string) {
  return {
    profile: { username: displayName, displayName },
    channels: [],
    follows: [],
  }
}

function directory(handle: string) {
  return (
    <HandleDirectory
      handle={handle}
      onChannelClick={() => {}}
      onHandleClick={() => {}}
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
