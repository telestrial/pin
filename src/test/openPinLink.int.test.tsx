// Pasting a link goes somewhere. It does not acquire anything.
//
// This box used to watch what it opened, which made it a second place where the
// follow-or-watch question got answered — and answered by default, without the buttons
// that exist to answer it. Now it parses an address and navigates, so it is the same act
// as clicking an author in a post or a channel on their profile: these are views.
//
// What that buys is covered here in both directions: the right destination for each shape
// of address, and NOTHING written on the way.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { OpenPinLink } from '../components/OpenPinLink'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const DID = 'did:dht:iyypk375c71qwjem5isiramudutoogo1t9gogz8f587sfkt9db4o'
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

describe('integration: opening a Pin link', () => {
  const onOpenChannel = vi.fn()
  const onOpenProfile = vi.fn()

  beforeEach(() => {
    resetAllStores()
    onOpenChannel.mockReset()
    onOpenProfile.mockReset()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  async function open(url: string) {
    render(
      <OpenPinLink
        onCancel={() => {}}
        onOpenChannel={onOpenChannel}
        onOpenProfile={onOpenProfile}
      />,
    )
    await userEvent.type(screen.getByRole('textbox'), url)
    await userEvent.click(screen.getByText('Open'))
  }

  it('opens a channel link on the channel, carrying its key', async () => {
    await open(`pin://${DID}#k=${KEY}`)

    expect(onOpenChannel).toHaveBeenCalledTimes(1)
    const [handle, didDht, , channelKey] = onOpenChannel.mock.calls[0]
    expect(handle).toBe('')
    expect(didDht).toBe(DID)
    // The key travels, or the page it opens has nothing to read the channel with —
    // which is the whole reason this is navigation rather than a fetch.
    expect(channelKey).toBe(KEY)
  })

  it('opens a keyless identity link on their profile', async () => {
    await open(`pin://${DID}`)

    expect(onOpenProfile).toHaveBeenCalledWith(DID)
    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it('watches nothing on the way', async () => {
    // The point of the change. Opening a link is a read, and the relation is a decision
    // the destination carries — so a paste must leave the stores exactly as it found them
    // even when the link is perfectly good.
    await open(`pin://${DID}#k=${KEY}`)

    expect(useAuthStore.getState().subscriptions).toEqual([])
    expect(useAuthStore.getState().follows).toEqual([])
    expect(useFeedStore.getState().entries).toEqual([])
  })

  it('reports a link it cannot read as a link, and goes nowhere', async () => {
    // A parse failure is the only failure this box can have. Whether the address leads
    // anywhere is the destination's question, and better answered by the page than
    // guessed at here.
    await open('https://example.com/not-a-pin-link')

    expect(onOpenChannel).not.toHaveBeenCalled()
    expect(onOpenProfile).not.toHaveBeenCalled()
    expect(screen.getByText(/^Invalid Pin link/)).toBeInTheDocument()
  })
})
