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

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

import { ChannelView } from '../components/channel/ChannelView'
import { channelKeyFromBase64 } from '../core/crypto'
import type { ChannelManifest, ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const THEM = 'did:dht:them'
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

function manifest(name: string, items: ItemRef[]): ChannelManifest {
  return {
    version: 1,
    name,
    description: 'theirs',
    authorPubkey: 'ed25519:aa',
    authorDidDht: THEM,
    publishedAt: '2026-09-01T00:00:00.000Z',
    visibility: 'public',
    items,
  } as ChannelManifest
}

/** What their channel currently publishes, behind the locator K derives. */
async function published(items: ItemRef[]) {
  const { publishLocator } = await import('../lib/channelLocatorNative')
  await publishLocator(
    channelKeyFromBase64(KEY),
    JSON.stringify(manifest('Their channel', items)),
  )
}

function view(channelKey?: string) {
  return render(
    <ChannelView
      authorHandle=""
      channelID={CHANNEL}
      channelKey={channelKey}
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
