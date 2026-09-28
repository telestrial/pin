// Where the link to a channel you own lives: on that channel's page, because that is
// where you go to share it.

import { cleanup, render, screen } from '@testing-library/react'
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
import { buildSubscribeURL } from '../core/channels'
import type { ChannelManifest, ChannelVisibility } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const ME = 'did:dht:me'
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const CHANNEL = 'newchannel000001'

describe('integration: the link to a channel you own', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>()

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
  })
  afterEach(cleanup)

  function owning(visibility: ChannelVisibility) {
    useAuthStore.setState({
      myDidDht: ME,
      myChannels: [
        {
          channelID: CHANNEL,
          channelKey: KEY,
          name: 'Fresh voice',
          createdAt: '2026-09-28T00:00:00.000Z',
          visibility,
        },
      ],
    })
    useFeedStore.setState({
      manifests: {
        [CHANNEL]: {
          version: 1,
          name: 'Fresh voice',
          description: '',
          authorPubkey: 'ed25519:aa',
          authorDidDht: ME,
          publishedAt: '2026-09-28T00:00:00.000Z',
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

  it.each(['public', 'obscure'] as const)(
    'copies the link to an owned %s channel',
    async (visibility) => {
      // Unlisted is the case that needs it most: no directory names the channel, so the
      // link is the only way anybody gets in.
      owning(visibility)

      view()

      await userEvent.click(
        await screen.findByRole('button', { name: 'Copy link' }),
      )
      expect(writeText).toHaveBeenCalledWith(buildSubscribeURL(ME, KEY))
    },
  )
})
