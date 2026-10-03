// Asking to read a private channel from its page.
//
// Signing a request is the Curator's — Rust, in the engine this tier has none of — so the
// request is stubbed to write what the Curator writes: the newest request, in this
// identity's own doc. What this covers is the screen: Follow on a private page asks, the
// record makes it read "Requested", and pressing that withdraws.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const requestAccess = vi.fn(
  async (
    _appKeyHex: string,
    _channelKey: Uint8Array,
    author: string,
    withdrawn: boolean,
  ) => {
    const { putRecord } = await import('../lib/docs')
    const { join_request_collection } = await import(
      '../../crates/pin-core/pkg/pin_core.js'
    )
    const request = {
      channelID: CHANNEL,
      author,
      actor: 'did:dht:me',
      encKey: 'ZW5j',
      createdAt: new Date().toISOString(),
      ...(withdrawn ? { withdrawn: true } : {}),
      sig: 'sig',
    }
    await putRecord(
      join_request_collection(),
      CHANNEL,
      new TextEncoder().encode(JSON.stringify(request)),
    )
    return request
  },
)
vi.mock('../lib/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/access')>()),
  requestAccess: (...args: Parameters<typeof requestAccess>) =>
    requestAccess(...args),
}))

import { ChannelView } from '../components/channel/ChannelView'
import { channelKeyFromBase64 } from '../core/crypto'
import { useAuthStore } from '../stores/auth'
import { didOfSync, fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const THEIR_APP_KEY = '22'.repeat(32)
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
// The channelID KEY derives, which the record is keyed by.
let CHANNEL = ''
let THEM = ''
beforeAll(async () => {
  THEM = didOfSync(THEIR_APP_KEY)
  const { deriveChannelID } = await import('../core/crypto')
  CHANNEL = await deriveChannelID(channelKeyFromBase64(KEY))
})

async function publishedPrivate() {
  const { publishLocator } = await import('../lib/channelLocatorNative')
  await publishLocator(
    THEIR_APP_KEY,
    channelKeyFromBase64(KEY),
    JSON.stringify({
      version: 1,
      name: 'The back room',
      description: 'members only',
      authorPubkey: 'ed25519:aa',
      authorDidDht: THEM,
      publishedAt: '2026-10-03T00:00:00.000Z',
      visibility: 'private',
      items: [],
    }),
  )
}

describe('integration: asking to read a private channel', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    requestAccess.mockClear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('asks with Follow, reads Requested, and withdraws', async () => {
    await publishedPrivate()
    render(
      <ChannelView
        authorHandle=""
        channelID={CHANNEL}
        channelKey={KEY}
        authorDid={THEM}
        onItemClick={() => {}}
        onChannelClick={() => {}}
        onHandleClick={() => {}}
        onBack={() => {}}
        sidebar={null}
        rightSidebar={null}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Follow' }))
    await waitFor(() => expect(requestAccess).toHaveBeenCalledTimes(1))
    const [appKey, channelKey, author, withdrawn] = requestAccess.mock.calls[0]
    expect(appKey).toBe(useAuthStore.getState().storedKeyHex)
    expect(channelKey).toEqual(channelKeyFromBase64(KEY))
    expect(author).toBe(THEM)
    expect(withdrawn).toBe(false)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Requested' }),
    )
    await waitFor(() => expect(requestAccess).toHaveBeenCalledTimes(2))
    expect(requestAccess.mock.calls[1][3]).toBe(true)
    expect(
      await screen.findByRole('button', { name: 'Follow' }),
    ).toBeInTheDocument()
  })
})
