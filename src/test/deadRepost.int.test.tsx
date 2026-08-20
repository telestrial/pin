// A portal in your own channel with nothing at the other end.
//
// Three things worth locking, and each of them is a distinction that would be easy to
// flatten: that a reader is told nothing, that an unreachable read is not reported as
// somebody's decision, and that dismissing it takes the portal out of the PUBLISHED
// manifest rather than only out of the view.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { DeadRepost } from '../components/channel/DeadRepost'
import type { RepostRef } from '../core/types'
import { resolveChannelViaLocator } from '../lib/channelLocator'
import { repostInChannel } from '../lib/channelWrites'
import { fakeDocStore as docStore } from './fakeModules'
import {
  authorCreateChannel,
  createFakeApp,
  mountAs,
  resetAllStores,
} from './setupFakeApp'

const SOURCE = 'did:dht:sourceauthor'

const REPOST: RepostRef = {
  didDht: SOURCE,
  channelID: 'srcchannel000001',
  publishedAt: '2026-05-01T09:00:00.000Z',
  repostedAt: '2026-06-01T09:00:00.000Z',
  cachedName: 'Their channel',
}

/** Sign in with one channel that already circulates the portal below. */
async function withACirculatedPost(app: ReturnType<typeof createFakeApp>) {
  const me = app.createAccount({ did: 'did:plc:me', handle: 'me.test' })
  const mine = await authorCreateChannel(me, { name: 'My channel' })
  mountAs(me, {
    myChannels: [
      {
        channelID: mine.channelID,
        channelKey: mine.channelKey,
        name: 'My channel',
      },
    ],
  })
  await repostInChannel(me.client, mine, REPOST)
  return mine
}

describe('integration: a dead portal in your own channel', () => {
  let app: ReturnType<typeof createFakeApp>

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    app = createFakeApp()
  })

  it('says the author deleted it, and that it will not come back', async () => {
    const mine = await withACirculatedPost(app)
    render(<DeadRepost channel={mine} repost={REPOST} state="deleted" />)

    expect(screen.getByText(/Their channel/)).toBeInTheDocument()
    expect(screen.getByText(/deleted this post/)).toBeInTheDocument()
    expect(screen.queryByText(/may come back/)).toBeNull()
  })

  it('says an un-advertised channel may come back', async () => {
    // Access withdrawn rather than content gone, and advertising is reversible — so
    // this one is not the same news as a retract and must not read like it.
    const mine = await withACirculatedPost(app)
    render(<DeadRepost channel={mine} repost={REPOST} state="unavailable" />)

    expect(screen.getByText(/no longer sharing/)).toBeInTheDocument()
    expect(screen.getByText(/may come back/)).toBeInTheDocument()
  })

  it('says nothing at all when the read simply failed', async () => {
    // An unreachable portal is the network, not a decision. Reporting it as one would
    // tell the owner their friend deleted something they did not.
    const mine = await withACirculatedPost(app)
    const { container } = render(
      <DeadRepost channel={mine} repost={REPOST} state="unreachable" />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('takes the portal out of the published manifest when dismissed', async () => {
    const mine = await withACirculatedPost(app)
    expect(
      (await resolveChannelViaLocator(mine.channelKey))?.reposts,
    ).toHaveLength(1)

    render(<DeadRepost channel={mine} repost={REPOST} state="deleted" />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(async () => {
      const published = await resolveChannelViaLocator(mine.channelKey)
      expect(published?.reposts).toBeUndefined()
    })
  })
})
