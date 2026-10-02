// The follow claim on a channel you authored.
//
// Creating a public channel follows it, because the claim is about the VOICE and is what
// puts an author among their own channel's followers. That makes this page the only place
// it can be taken back: the sidebar keeps owned channels out of Following, and
// `followsOfOthers` keeps a self-follow out of the profile's, both because a self-follow
// read as attention would say a profile follows somebody when it follows nobody.
//
// And the claim is all it is. The watch half of a follow acquires a read capability, and
// on your own channel there is none to acquire — so unfollowing must leave the
// subscription the create wrote standing, or your own voice drops out of your own feed.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
import type { ChannelManifest, ChannelVisibility } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const ME = 'did:dht:me'
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const CHANNEL = 'myownchannel0001'

function manifest(visibility: ChannelVisibility = 'public'): ChannelManifest {
  return {
    version: 1,
    name: 'My own voice',
    description: 'mine',
    authorPubkey: 'ed25519:aa',
    authorDidDht: ME,
    publishedAt: '2026-09-01T00:00:00.000Z',
    visibility,
    items: [],
  } as ChannelManifest
}

/** Signed in, owning this channel, exactly as the create leaves things: in myChannels,
 *  subscribed to itself, and followed when it is public. */
function owning(visibility: ChannelVisibility = 'public') {
  useAuthStore.setState({
    myDidDht: ME,
    myChannels: [
      {
        channelID: CHANNEL,
        channelKey: KEY,
        name: 'My own voice',
        createdAt: '2026-09-01T00:00:00.000Z',
        visibility,
      },
    ],
    subscriptions: [
      {
        authorHandle: '',
        authorDID: '',
        didDht: ME,
        channelID: CHANNEL,
        channelKey: KEY,
        addedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    follows:
      visibility === 'public'
        ? [{ didDht: ME, channelID: CHANNEL, name: 'My own voice' }]
        : [],
  })
  useFeedStore.setState({ manifests: { [CHANNEL]: manifest(visibility) } })
}

function view() {
  return render(
    <ChannelView
      authorHandle=""
      channelID={CHANNEL}
      onItemClick={() => {}}
      onChannelClick={() => {}}
      onHandleClick={() => {}}
      onEdit={() => {}}
      onUnpin={() => {}}
      onBack={() => {}}
      sidebar={null}
      rightSidebar={null}
    />,
  )
}

describe('integration: the follow claim on your own channel', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('can be taken back, and leaves the subscription standing', async () => {
    // Unfollowing your own channel drops the public claim and nothing else. The watch
    // half exists to acquire a read capability you already have, and releasing it would
    // take your own voice out of your own feed.
    owning()

    view()

    const button = await screen.findByRole('button', { name: 'Following' })
    await userEvent.click(button)

    await waitFor(() => {
      expect(useAuthStore.getState().follows).toEqual([])
    })
    expect(screen.getByRole('button', { name: 'Follow' })).toBeInTheDocument()
    expect(useAuthStore.getState().subscriptions).toHaveLength(1)
  })

  it('offers no follow claim on an unlisted channel you own', async () => {
    // Nobody can follow one: a FollowEdge carries no K and resolves through the author's
    // directory, where an unlisted channel is absent by construction. Absent rather than
    // disabled — there is nothing to enable.
    owning('secret')

    view()

    await waitFor(() =>
      expect(screen.getByText('My own voice')).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Following' })).toBeNull()
  })
})
