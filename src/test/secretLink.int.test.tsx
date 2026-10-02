// A Secret channel's link, opened by somebody it was not shared with.
//
// Forwarding a Secret link grants nothing, and the page has to say so without saying
// anything else: no name, no picture, no request button. What tells the page is the resolve
// itself — the author's signature verifies and the object then refuses to open for want of
// a key — so these cover that reading against a network failure, which must not become a
// claim about who is invited, and against an invitation whose key has not been climbed to
// yet, which is the one case where "no key held" is not a refusal.
//
// The resolve is stubbed with the exact strings `pin-channel` and `pin-curator` produce;
// both are pinned by a Rust test where they are made.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
  membership_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ChannelView } from '../components/channel/ChannelView'
import type { ChannelManifest } from '../core/types'
import { putRecord } from '../lib/docs'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const AUTHOR = 'did:dht:author'
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const CHANNEL = 'secretchannel001'

const MANIFEST = {
  version: 1,
  name: 'The back room',
  description: 'members only',
  authorPubkey: 'ed25519:aa',
  authorDidDht: AUTHOR,
  publishedAt: '2026-10-01T00:00:00.000Z',
  visibility: 'secret',
  items: [],
} as unknown as ChannelManifest

function view() {
  return render(
    <ChannelView
      authorHandle={AUTHOR}
      authorDid={AUTHOR}
      channelID={CHANNEL}
      channelKey={KEY}
      onItemClick={() => {}}
      onChannelClick={() => {}}
      onHandleClick={() => {}}
      onBack={() => {}}
      sidebar={null}
      rightSidebar={null}
    />,
  )
}

describe('integration: a Secret link opened without an invitation', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    resolveChannelViaLocator.mockReset()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('says only that you are not invited', async () => {
    resolveChannelViaLocator.mockRejectedValue('no read key for epoch 2')
    view()

    expect(await screen.findByText('You’re not invited.')).toBeInTheDocument()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByText(CHANNEL)).toBeNull()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Back',
    ])
  })

  it('makes no claim when the channel could not be reached', async () => {
    resolveChannelViaLocator.mockRejectedValue('timed out resolving locator')
    view()

    await waitFor(() => expect(resolveChannelViaLocator).toHaveBeenCalled())
    await screen.findByText('No items yet.')
    expect(screen.queryByText('You’re not invited.')).toBeNull()
  })

  it('waits on an invitation whose key has not been climbed to, then opens', async () => {
    docStore.set(
      `${membership_collection()}/${CHANNEL}`,
      new TextEncoder().encode(
        JSON.stringify({
          channelKey: KEY,
          author: AUTHOR,
          authorEncKey: 'ZW5j',
          leaf: 1,
          seatId: 'seat-1',
        }),
      ),
    )
    resolveChannelViaLocator.mockRejectedValue(
      'no content key held for epoch 2',
    )
    view()

    await screen.findByText(/hasn’t opened yet/)
    expect(screen.queryByText('You’re not invited.')).toBeNull()

    // The Curator climbs and writes the key; the page reads again on that write.
    resolveChannelViaLocator.mockResolvedValue(MANIFEST)
    await putRecord(
      content_key_collection(),
      `${CHANNEL}:2;`,
      new TextEncoder().encode(JSON.stringify({ key: 'k' })),
    )

    expect(
      await screen.findByRole('heading', { name: 'The back room' }),
    ).toBeInTheDocument()
  })
})
