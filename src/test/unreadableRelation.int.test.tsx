// A relation to a channel that can no longer be read.
//
// A channel's author can retract it, and a locator can stop resolving. Either way the page
// has no manifest, and the relation controls used to render only beside one — so a channel
// you watched or followed stayed in your list with no way to drop it. Dropping needs only
// the relation you hold, so it stays available; starting one still needs the channel.

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
import { useAuthStore } from '../stores/auth'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const AUTHOR = 'did:dht:gone'
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const CHANNEL = 'retractedchan001'

/** Watching a channel nothing publishes any more: no manifest anywhere. */
function watching() {
  useAuthStore.setState({
    subscriptions: [
      {
        authorHandle: '',
        authorDID: '',
        didDht: AUTHOR,
        channelID: CHANNEL,
        channelKey: KEY,
        cachedName: 'Gone now',
        addedAt: '2026-10-01T00:00:00.000Z',
      },
    ],
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
      onBack={() => {}}
      sidebar={null}
      rightSidebar={null}
    />,
  )
}

describe('integration: a relation to a channel that cannot be read', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('can still be unwatched', async () => {
    watching()
    view()

    await userEvent.click(
      await screen.findByRole('button', { name: 'Watching' }),
    )

    await waitFor(() =>
      expect(useAuthStore.getState().subscriptions).toEqual([]),
    )
  })

  it('can still be unfollowed', async () => {
    watching()
    useAuthStore.setState({
      follows: [{ didDht: AUTHOR, channelID: CHANNEL, name: 'Gone now' }],
    })
    view()

    await userEvent.click(
      await screen.findByRole('button', { name: 'Following' }),
    )

    await waitFor(() => {
      expect(useAuthStore.getState().follows).toEqual([])
      expect(useAuthStore.getState().subscriptions).toEqual([])
    })
  })
})
