// The people asking to read a private channel you own, and answering them.
//
// Answering is the Curator's — Rust, which this tier has no engine for — so approve and deny
// are stubbed. What this covers is who is shown as waiting, the count that says so on the
// page and in the sidebar, and that an answer leaving the inbox takes the person off both.

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
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)

const approveRequest = vi.fn(async (..._args: unknown[]) => {})
const denyRequest = vi.fn(async (..._args: unknown[]) => {})
vi.mock('../lib/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/access')>()),
  approveRequest: (...args: unknown[]) => approveRequest(...args),
  denyRequest: (...args: unknown[]) => denyRequest(...args),
}))

import {
  directory_collection,
  join_decision_collection,
  join_inbox_collection,
  members_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ChannelView } from '../components/channel/ChannelView'
import { Sidebar } from '../components/Sidebar'
import { channelKeyFromBase64 } from '../core/crypto'
import type { ChannelManifest } from '../core/types'
import { putRecord } from '../lib/docs'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const ME = 'did:dht:me'
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const CHANNEL = 'myprivatechann01'
const BOB = 'did:dht:bob'
const CAROL = 'did:dht:carol'
const DAVE = 'did:dht:dave'
const EVE = 'did:dht:eve'

const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))

function asked(did: string, createdAt: string, withdrawn = false) {
  docStore.set(
    `${join_inbox_collection()}/${CHANNEL}:${did}`,
    encode({
      channelID: CHANNEL,
      author: ME,
      actor: did,
      encKey: 'ZW5j',
      createdAt,
      ...(withdrawn ? { withdrawn: true } : {}),
      sig: 'sig',
    }),
  )
}

function named(did: string, username: string) {
  docStore.set(
    `${directory_collection()}/${did}`,
    encode({
      tier: 'full',
      profile: { username },
      channels: [],
      reach: [],
      follows: [],
      handleFollows: [],
      url: 'sia://held',
      epoch: 1,
      seenAt: '2026-10-01T00:00:00.000Z',
    }),
  )
}

function owning() {
  useAuthStore.setState({
    myDidDht: ME,
    myChannels: [
      {
        channelID: CHANNEL,
        channelKey: KEY,
        name: 'Back room',
        createdAt: '2026-10-01T00:00:00.000Z',
        visibility: 'private',
      },
    ],
    subscriptions: [
      {
        authorHandle: '',
        authorDID: '',
        didDht: ME,
        channelID: CHANNEL,
        channelKey: KEY,
        addedAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  })
  useFeedStore.setState({
    manifests: {
      [CHANNEL]: {
        version: 1,
        name: 'Back room',
        description: '',
        authorPubkey: 'ed25519:aa',
        authorDidDht: ME,
        publishedAt: '2026-10-01T00:00:00.000Z',
        visibility: 'private',
        items: [],
      } as ChannelManifest,
    },
  })
}

function page() {
  return render(
    <>
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
      />
      <Sidebar
        onHome={() => {}}
        onCurate={() => {}}
        onSettings={() => {}}
        onCreate={() => {}}
        onOpenLink={() => {}}
        onSeeAll={() => {}}
        onChannelClick={() => {}}
      />
    </>,
  )
}

describe('integration: answering requests to read a private channel', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    approveRequest.mockClear()
    denyRequest.mockClear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
    for (const [did, name] of [
      [BOB, 'bob'],
      [CAROL, 'carol'],
      [DAVE, 'dave'],
      [EVE, 'eve'],
    ]) {
      named(did, name)
    }
    // Waiting: bob. Withdrawn: carol. Already answered: dave. Already a member: eve.
    asked(BOB, '2026-10-03T00:00:01Z')
    asked(CAROL, '2026-10-03T00:00:02Z', true)
    asked(DAVE, '2026-10-03T00:00:03Z')
    asked(EVE, '2026-10-03T00:00:04Z')
    docStore.set(
      `${join_decision_collection()}/${CHANNEL}:${DAVE}`,
      encode({ decision: 'denied', requestCreatedAt: '2026-10-03T00:00:03Z' }),
    )
    docStore.set(
      `${members_collection()}/${CHANNEL}:seat1`,
      encode({
        id: 'seat1',
        did: EVE,
        encKey: 'ZW5j',
        leaf: 0,
        addedAt: '2026-10-03T00:00:05Z',
      }),
    )
    owning()
  })
  afterEach(cleanup)

  async function openRequests() {
    await userEvent.click(
      await screen.findByRole('button', { name: 'Requests · 1' }),
    )
    return screen.findByRole('region', { name: 'Requests' })
  }

  it('lists only who is waiting, and counts them on the page and in the sidebar', async () => {
    page()
    const panel = await openRequests()
    await waitFor(() => expect(panel).toHaveTextContent('@bob'))
    for (const name of ['@carol', '@dave', '@eve']) {
      expect(panel).not.toHaveTextContent(name)
    }
    const row = within(
      screen.getByRole('list', { name: 'Your channels' }),
    ).getByRole('button', { name: /Back room/ })
    expect(row).toHaveTextContent('1')
  })

  it('approves and denies through the Curator', async () => {
    page()
    await openRequests()

    await userEvent.click(
      await screen.findByRole('button', { name: 'Approve' }),
    )
    await waitFor(() => expect(approveRequest).toHaveBeenCalledTimes(1))
    const [appKey, channelKey, did] = approveRequest.mock.calls[0]
    expect(appKey).toBe(useAuthStore.getState().storedKeyHex)
    expect(channelKey).toEqual(channelKeyFromBase64(KEY))
    expect(did).toBe(BOB)

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() =>
      expect(denyRequest).toHaveBeenCalledWith(
        useAuthStore.getState().storedKeyHex,
        CHANNEL,
        BOB,
      ),
    )
  })

  it('takes somebody off both once they are answered', async () => {
    page()
    const panel = await openRequests()
    await waitFor(() => expect(panel).toHaveTextContent('@bob'))

    await putRecord(
      join_decision_collection(),
      `${CHANNEL}:${BOB}`,
      encode({
        decision: 'approved',
        requestCreatedAt: '2026-10-03T00:00:01Z',
      }),
    )

    expect(await screen.findByText('Nobody is waiting.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Requests' })).toBeInTheDocument()
  })
})
