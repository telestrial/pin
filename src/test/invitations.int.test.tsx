// Invitations to Secret channels, as the sidebar offers them.
//
// The Curator writes a membership when an invitation opens and climbs to the channel's key
// on its next pull; both are Rust and covered there. What this covers is the screen's half:
// which memberships still read as pending, that a channel is offered for acceptance only
// once it can be read — and is tried again when its key lands — and that accepting watches
// it with the invitation's key while dismissing leaves a settings entry.

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)
vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)

const resolveChannelViaLocator = vi.fn(
  async (_key: string, _author: string): Promise<unknown> => null,
)
vi.mock('../lib/channelLocator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/channelLocator')>()),
  resolveChannelViaLocator: (key: string, author: string) =>
    resolveChannelViaLocator(key, author),
}))

import {
  content_key_collection,
  directory_collection,
  membership_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
import { Sidebar } from '../components/Sidebar'
import type { ChannelManifest } from '../core/types'
import { putRecord } from '../lib/docs'
import { useAuthStore } from '../stores/auth'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const ALICE = 'did:dht:alice'
const CHANNEL = 'secretchannel001'
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value))

function invited(channelID = CHANNEL) {
  docStore.set(
    `${membership_collection()}/${channelID}`,
    encode({
      channelKey: KEY,
      author: ALICE,
      authorEncKey: 'ZW5j',
      leaf: 3,
      seatId: 'seat-1',
    }),
  )
}

function holdAlice() {
  docStore.set(
    `${directory_collection()}/${ALICE}`,
    encode({
      tier: 'full',
      profile: { username: 'alice' },
      channels: [],
      reach: [],
      follows: [],
      handleFollows: [],
      url: 'sia://held',
      epoch: 1,
      seenAt: '2026-09-01T12:00:00.000Z',
    }),
  )
}

const MANIFEST = {
  version: 1,
  name: 'The back room',
  description: '',
  authorPubkey: 'ed25519:aa',
  authorDidDht: ALICE,
  publishedAt: '2026-10-01T00:00:00.000Z',
  visibility: 'secret',
  items: [],
} as unknown as ChannelManifest

function sidebar() {
  return render(
    <Sidebar
      onHome={() => {}}
      onCurate={() => {}}
      onSettings={() => {}}
      onCreate={() => {}}
      onOpenLink={() => {}}
      onSeeAll={() => {}}
      onChannelClick={() => {}}
    />,
  )
}

const invitations = () =>
  within(screen.getByRole('list', { name: 'Invitations to channels' }))

describe('integration: invitations in the sidebar', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    resolveChannelViaLocator.mockReset()
    resolveChannelViaLocator.mockResolvedValue(null)
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
    holdAlice()
  })
  afterEach(cleanup)

  it('accepts by watching the channel with the invitation’s key', async () => {
    invited()
    resolveChannelViaLocator.mockResolvedValue(MANIFEST)
    sidebar()

    await waitFor(() =>
      expect(invitations().getByText('The back room')).toBeInTheDocument(),
    )
    expect(resolveChannelViaLocator).toHaveBeenCalledWith(KEY, ALICE)
    await waitFor(() =>
      expect(invitations().getByText('from @alice')).toBeInTheDocument(),
    )

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Accept the invitation to The back room',
      }),
    )

    await waitFor(() =>
      expect(useAuthStore.getState().subscriptions).toMatchObject([
        { channelID: CHANNEL, channelKey: KEY, didDht: ALICE },
      ]),
    )
    expect(
      screen.queryByRole('list', { name: 'Invitations to channels' }),
    ).toBeNull()
  })

  // Each test below takes a channel of its own: what an invitation opened to is kept for
  // the session, so one this file already opened would skip the state under test.
  it('offers acceptance once the channel opens, trying again when its key lands', async () => {
    const channel = 'secretchannel002'
    invited(channel)
    sidebar()

    const accept = await screen.findByRole('button', {
      name: 'Accept the invitation to A secret channel',
    })
    expect(accept).toBeDisabled()
    expect(invitations().getByText(/opening…/)).toBeInTheDocument()

    // The Curator climbs to the channel's key and writes it; that is what makes it
    // readable, and what the row is waiting on.
    resolveChannelViaLocator.mockResolvedValue(MANIFEST)
    await putRecord(
      content_key_collection(),
      `${channel}:0;`,
      encode({ key: 'k' }),
    )

    expect(
      await screen.findByRole('button', {
        name: 'Accept the invitation to The back room',
      }),
    ).toBeEnabled()
  })

  it('dismisses into settings, leaving the membership standing', async () => {
    const channel = 'secretchannel003'
    invited(channel)
    sidebar()

    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Dismiss the invitation to A secret channel',
      }),
    )

    expect(useAuthStore.getState().dismissedInvitations).toEqual([channel])
    expect(
      screen.queryByRole('list', { name: 'Invitations to channels' }),
    ).toBeNull()
    expect(docStore.has(`${membership_collection()}/${channel}`)).toBe(true)
  })

  it('does not offer a channel already watched', async () => {
    invited()
    useAuthStore.setState({
      subscriptions: [
        {
          authorHandle: '',
          authorDID: '',
          didDht: ALICE,
          channelID: CHANNEL,
          channelKey: KEY,
          addedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    })
    invited('anotherchannel01')
    sidebar()

    // The other invitation renders, so the list was read — the watched one is filtered,
    // not merely not loaded yet.
    await waitFor(() =>
      expect(
        invitations().getAllByRole('button', { name: /^Dismiss/ }),
      ).toHaveLength(1),
    )
  })
})
