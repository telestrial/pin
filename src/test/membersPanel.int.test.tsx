// Who can read a Secret channel you own, and inviting and removing them.
//
// The roster and the invitation are the Curator's — inviting seals an invitation to the
// person's encryption key and seats them in the member tree, both in Rust — so what this
// covers is the seam: the button appears on your own Secret channel and nowhere else, the
// list is the roster's standing seatings, and a pick hands Rust the key the person's
// directory publishes, or says why it cannot.

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

const inviteMember = vi.fn(async (..._args: unknown[]) => ({}))
const removeMember = vi.fn(async (..._args: unknown[]) => 1)
vi.mock('../lib/members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/members')>()),
  inviteMember: (...args: unknown[]) => inviteMember(...args),
  removeMember: (...args: unknown[]) => removeMember(...args),
}))

import {
  directory_collection,
  members_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ChannelView } from '../components/channel/ChannelView'
import { channelKeyFromBase64 } from '../core/crypto'
import type { ChannelManifest, ChannelVisibility } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const ME = 'did:dht:me'
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const CHANNEL = 'mysecretchannel1'
const ALICE = 'did:dht:alice'
const BOB = 'did:dht:bob'
const ENC = 'ZW5jcnlwdGlvbi1rZXktb2YtYWxpY2UtMzItYnl0ZXM='

const put = (key: string, value: unknown) =>
  docStore.set(key, new TextEncoder().encode(JSON.stringify(value)))

/** A directory record as the crawl writes one, with or without an encryption key. */
function hold(didDht: string, username: string, encKey?: string) {
  put(`${directory_collection()}/${didDht}`, {
    tier: 'full',
    profile: { username, displayName: username },
    channels: [],
    reach: [],
    follows: [],
    handleFollows: [],
    ...(encKey ? { encKey } : {}),
    url: 'sia://held',
    epoch: 1,
    seenAt: '2026-09-01T12:00:00.000Z',
  })
}

function seat(id: string, did: string, removedAt?: string) {
  put(`${members_collection()}/${CHANNEL}:${id}`, {
    id,
    did,
    encKey: ENC,
    leaf: 0,
    addedAt: '2026-10-01T00:00:00.000Z',
    ...(removedAt ? { removedAt } : {}),
  })
}

function owning(visibility: ChannelVisibility) {
  useAuthStore.setState({
    myDidDht: ME,
    myChannels: [
      {
        channelID: CHANNEL,
        channelKey: KEY,
        name: 'Hidden room',
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
  })
  useFeedStore.setState({
    manifests: {
      [CHANNEL]: {
        version: 1,
        name: 'Hidden room',
        description: '',
        authorPubkey: 'ed25519:aa',
        authorDidDht: ME,
        publishedAt: '2026-09-01T00:00:00.000Z',
        visibility,
        items: [],
      } as ChannelManifest,
    },
  })
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

async function openMembers() {
  view()
  await userEvent.click(await screen.findByRole('button', { name: 'Members' }))
  return screen.findByRole('region', { name: 'Members' })
}

describe('integration: the members of a Secret channel you own', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    inviteMember.mockClear()
    removeMember.mockClear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('offers Members on a Secret channel and not on a public one', async () => {
    owning('public')
    view()
    await screen.findByRole('button', { name: 'Copy link' })
    expect(screen.queryByRole('button', { name: 'Members' })).toBeNull()
  })

  it('lists the standing members, leaving a removed seating out', async () => {
    hold(ALICE, 'alice', ENC)
    hold(BOB, 'bob', ENC)
    seat('s1', ALICE)
    seat('s2', BOB, '2026-10-01T01:00:00.000Z')
    owning('secret')

    const panel = await openMembers()

    await waitFor(() => expect(panel).toHaveTextContent('@alice'))
    expect(panel).not.toHaveTextContent('@bob')
  })

  it('invites a person with the key their directory publishes', async () => {
    hold(ALICE, 'alice', ENC)
    owning('secret')
    const panel = await openMembers()

    await userEvent.type(screen.getByRole('searchbox'), 'alice')
    await userEvent.click(await screen.findByRole('button', { name: '@alice' }))

    await waitFor(() => expect(inviteMember).toHaveBeenCalledTimes(1))
    const [appKey, channelKey, did, encKey] = inviteMember.mock.calls[0]
    expect(appKey).toBe(useAuthStore.getState().storedKeyHex)
    expect(channelKey).toEqual(channelKeyFromBase64(KEY))
    expect(did).toBe(ALICE)
    expect(encKey).toBe(ENC)
    expect(panel).toBeInTheDocument()
  })

  it('says why somebody with no encryption key cannot be invited', async () => {
    hold(BOB, 'bob')
    owning('secret')
    await openMembers()

    await userEvent.type(screen.getByRole('searchbox'), 'bob')
    await userEvent.click(await screen.findByRole('button', { name: '@bob' }))

    await screen.findByText(/haven’t published an encryption key/)
    expect(inviteMember).not.toHaveBeenCalled()
  })

  it('removes a member from the roster', async () => {
    hold(ALICE, 'alice', ENC)
    seat('s1', ALICE)
    owning('secret')
    await openMembers()

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(removeMember).toHaveBeenCalledWith(CHANNEL, ALICE),
    )
  })
})
