// A channel being set up, and where its link lives once it is.
//
// Creating a channel is a journaled action: K and the channelID are minted at enqueue, and
// the channel enters settings only once its manifest is published, because settings is
// what the identity loop advertises. So the sidebar draws a channel still being set up
// from the JOURNAL, under the channelID the finished entry will take — which is what lets
// the create put you straight back where you were rather than holding you on a
// confirmation screen.
//
// And with that screen gone, the share link lives on the page of a channel you own.

import { cleanup, render, screen, within } from '@testing-library/react'
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
import { PinSidebar } from '../components/pin/PinSidebar'
import { Sidebar } from '../components/Sidebar'
import { buildSubscribeURL } from '../core/channels'
import type { ChannelManifest, ChannelVisibility } from '../core/types'
import {
  type ChannelCreateAction,
  CREATE_PHASE_PUBLISHING,
  CREATE_PHASE_UPLOADING,
  useActionStore,
} from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const ME = 'did:dht:me'
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const CHANNEL = 'newchannel000001'

function creating(
  state: ChannelCreateAction['state'],
  name = 'Fresh voice',
): ChannelCreateAction {
  return {
    id: `act-${state}`,
    kind: 'channel-create',
    state,
    progress: 0,
    createdAt: '2026-09-28T00:00:00.000Z',
    title: name,
    successLabel: 'Created',
    failLabel: 'Create',
    intent: {
      channelKey: KEY,
      channelID: CHANNEL,
      name,
      description: '',
      visibility: 'public',
      showOnProfile: true,
      authorDidDht: ME,
    },
    ledger: {},
  }
}

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

function yourChannels() {
  return within(screen.getByRole('list', { name: 'Your channels' }))
}

describe('integration: a channel being set up', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
    useAuthStore.setState({ myChannels: [], subscriptions: [], follows: [] })
  })
  afterEach(cleanup)

  it('appears in your channels the moment it is queued', () => {
    // Before any byte moves and before settings knows about it: the journal holds the
    // intent, and that is enough to show the channel as active.
    useActionStore.setState({ actions: [creating('pending')] })

    sidebar()

    const list = yourChannels()
    expect(list.getByText('Fresh voice')).toBeInTheDocument()
    expect(list.getByText('Starting…')).toBeInTheDocument()
    expect(list.queryByRole('button', { name: /Retry setting up/ })).toBeNull()
  })

  it('says it is waiting when another action holds the runner', () => {
    // The journal runs one action at a time, so a create queued behind a post still
    // uploading has not started — and a row that said "Starting…" for a minute would
    // read as stuck.
    const post = { ...creating('running'), id: 'act-post', kind: 'publish' }
    useActionStore.setState({
      actions: [post as never, creating('pending')],
    })

    sidebar()

    expect(
      yourChannels().getByText('Waiting for another upload…'),
    ).toBeInTheDocument()
  })

  it('reports the upload with its progress, then the publish', () => {
    const uploading = {
      ...creating('running'),
      phase: CREATE_PHASE_UPLOADING,
      progress: 41.6,
    }
    useActionStore.setState({ actions: [uploading] })
    const { unmount } = sidebar()
    expect(
      yourChannels().getByText('Uploading images · 42%'),
    ).toBeInTheDocument()
    unmount()

    useActionStore.setState({
      actions: [{ ...uploading, phase: CREATE_PHASE_PUBLISHING, progress: 97 }],
    })
    sidebar()
    expect(
      yourChannels().getByText('Publishing to the network…'),
    ).toBeInTheDocument()
  })

  it('offers a retry and a dismiss when setting up failed', async () => {
    // A journaled action can exhaust, and a spinner with no failure branch would spin
    // forever. The two gestures are the journal's own.
    useActionStore.setState({
      actions: [{ ...creating('failed'), error: 'Sia is not connected' }],
    })

    sidebar()

    const list = yourChannels()
    expect(list.getByText("Couldn't set up")).toHaveAttribute(
      'title',
      'Sia is not connected',
    )
    await userEvent.click(
      list.getByRole('button', { name: 'Retry setting up Fresh voice' }),
    )
    expect(useActionStore.getState().actions[0].state).toBe('pending')
  })

  it('dismissing a failed set-up removes it', async () => {
    useActionStore.setState({ actions: [creating('failed')] })

    sidebar()

    await userEvent.click(
      yourChannels().getByRole('button', { name: 'Dismiss Fresh voice' }),
    )
    expect(useActionStore.getState().actions).toEqual([])
  })

  it('gives way to the real entry under the same channelID', () => {
    // The commit writes the settings entry before the action reports success, so for a
    // moment both exist. One row, and it is the real one.
    useActionStore.setState({ actions: [creating('running')] })
    useAuthStore.setState({
      myChannels: [
        {
          channelID: CHANNEL,
          channelKey: KEY,
          name: 'Fresh voice',
          createdAt: '2026-09-28T00:00:01.000Z',
          visibility: 'public',
        },
      ],
    })

    sidebar()

    const list = yourChannels()
    expect(list.getAllByText('Fresh voice')).toHaveLength(1)
    expect(list.queryByText('Setting up…')).toBeNull()
  })
})

describe('integration: the in-flight list leaves a create to the sidebar', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('lists other actions and not a channel being created', () => {
    // The channel's row in the Channels list is where it is shown, retry included;
    // showing it in the right sidebar too would be the same fact twice.
    const post = {
      ...creating('pending', 'A post'),
      id: 'act-post',
      kind: 'publish',
      title: 'A post in flight',
    }
    useActionStore.setState({
      actions: [post as never, creating('pending', 'Fresh voice')],
    })

    render(<PinSidebar />)

    const queue = within(screen.getByRole('list', { name: 'Upload queue' }))
    expect(queue.getByText('A post in flight')).toBeInTheDocument()
    expect(queue.queryByText('Fresh voice')).toBeNull()
  })
})

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
