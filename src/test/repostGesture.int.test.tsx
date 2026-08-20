// The repost gesture, driven through the real button.
//
// What a hook test cannot see, and what these lock: that a checkmark reaches the channel's
// PUBLISHED manifest rather than only local state, that unchecking takes it back out, that
// the menu offers the channels it should and hides the ones it must, and that a portal
// carries no bytes — which is the property the whole reference model rests on.

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

import { EngagementRow } from '../components/engagement/EngagementRow'
import type { FeedEntry } from '../core/feed'
import { resolveChannelViaLocator } from '../lib/channelLocator'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import {
  authorCreateChannel,
  createFakeApp,
  type FakeAccount,
  mountAs,
  publishTextPost,
  resetAllStores,
} from './setupFakeApp'

const SOURCE = 'did:dht:sourceauthor'
const SRC_CHANNEL = 'srcchannel000001'
const POST_AT = '2026-05-01T09:00:00.000Z'

/** A post by somebody else, as the feed presents it: a public channel with a did:dht
 *  author, which is what makes it repostable at all. */
function theirPost(): FeedEntry {
  return {
    item: {
      id: 'obj1',
      itemURL: 'sia://fake/obj1#k=obj1',
      type: 'text',
      title: '',
      summary: 'worth circulating',
      publishedAt: POST_AT,
      mimeType: 'text/markdown',
      byteSize: 17,
    },
    channel: {
      authorHandle: '',
      authorDidDht: SOURCE,
      channelID: SRC_CHANNEL,
      name: 'Their channel',
    },
  }
}

const INPUT = {
  item: theirPost().item,
  channel: { authorHandle: '', channelID: SRC_CHANNEL, name: 'Their channel' },
}

/** The source channel as the reader knows it — public, so the gesture is offered. */
function knowSourceIsPublic(visibility: 'public' | 'obscure' = 'public') {
  useFeedStore.getState().setManifest(SRC_CHANNEL, {
    version: 1,
    name: 'Their channel',
    description: '',
    authorPubkey: 'pubkey',
    authorDidDht: SOURCE,
    publishedAt: POST_AT,
    visibility,
    items: [],
  })
}

/** Sign in as somebody with one channel of their own to circulate things through. */
async function withOwnChannel(app: ReturnType<typeof createFakeApp>) {
  const me: FakeAccount = app.createAccount({
    did: 'did:plc:me',
    handle: 'me.test',
  })
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
  useFeedStore.getState().setManifest(mine.channelID, mine.manifest)
  return { me, mine }
}

const repostButton = () => screen.getByRole('button', { name: 'Repost' })

describe('integration: the repost gesture', () => {
  let app: ReturnType<typeof createFakeApp>

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    app = createFakeApp()
  })

  it('publishes a portal into the channel the reader picks', async () => {
    const { mine } = await withOwnChannel(app)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    await userEvent.click(
      screen.getByRole('menuitemcheckbox', { name: /My channel/ }),
    )

    // The published manifest, read back off the locator the way a subscriber would.
    await waitFor(async () => {
      const published = await resolveChannelViaLocator(mine.channelKey)
      expect(published?.reposts).toHaveLength(1)
    })
    const published = await resolveChannelViaLocator(mine.channelKey)
    expect(published?.reposts?.[0]).toMatchObject({
      didDht: SOURCE,
      channelID: SRC_CHANNEL,
      publishedAt: POST_AT,
    })
  })

  it('carries no bytes into the channel that circulates it', async () => {
    // The whole reference model: a repost adds an address, never a copy. If it moved
    // bytes, the author could not take it back and an edit could not show through.
    const { mine } = await withOwnChannel(app)
    knowSourceIsPublic()
    const before = app.world.objects.size

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    await userEvent.click(
      screen.getByRole('menuitemcheckbox', { name: /My channel/ }),
    )
    await waitFor(async () => {
      expect(
        (await resolveChannelViaLocator(mine.channelKey))?.reposts,
      ).toHaveLength(1)
    })

    // One new object, and it is the channel's own rewritten manifest — nothing of the
    // post itself was copied.
    expect(app.world.objects.size - before).toBe(1)
  })

  it('takes the portal back out when unchecked', async () => {
    const { mine } = await withOwnChannel(app)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    const row = () =>
      screen.getByRole('menuitemcheckbox', { name: /My channel/ })
    await userEvent.click(row())
    await waitFor(() => expect(row()).toHaveAttribute('aria-checked', 'true'))

    await userEvent.click(row())
    await waitFor(async () => {
      const published = await resolveChannelViaLocator(mine.channelKey)
      expect(published?.reposts).toBeUndefined()
    })
  })

  it('shows which of your channels already carry it', async () => {
    const { mine } = await withOwnChannel(app)
    knowSourceIsPublic()
    useFeedStore.getState().setManifest(mine.channelID, {
      ...mine.manifest,
      reposts: [
        {
          didDht: SOURCE,
          channelID: SRC_CHANNEL,
          publishedAt: POST_AT,
          repostedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    })

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    expect(
      screen.getByRole('menuitemcheckbox', { name: /My channel/ }),
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('offers nothing for a post in an unlisted channel', async () => {
    // Circulating it would publish the channel's existence, and the portal could not
    // resolve anyway. Hiding the gesture says out loud what the mechanism would do.
    await withOwnChannel(app)
    knowSourceIsPublic('obscure')

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    expect(screen.queryByRole('button', { name: 'Repost' })).toBeNull()
  })

  it('offers nothing when this identity has no channel of its own', async () => {
    const me = app.createAccount({ did: 'did:plc:me', handle: 'me.test' })
    mountAs(me)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    expect(screen.queryByRole('button', { name: 'Repost' })).toBeNull()
  })

  it('does not offer to circulate a post into the channel it is already in', async () => {
    // Self-repost is allowed — posting to one voice and circulating through another is
    // a headline use — but a channel cannot repost into itself.
    const me = app.createAccount({ did: 'did:plc:me', handle: 'me.test' })
    const mine = await authorCreateChannel(me, { name: 'My channel' })
    await publishTextPost(me, mine, 'my own post')
    mountAs(me, {
      myChannels: [
        {
          channelID: mine.channelID,
          channelKey: mine.channelKey,
          name: 'My channel',
        },
      ],
    })
    const published = await resolveChannelViaLocator(mine.channelKey)
    if (!published) throw new Error('not resolvable')
    useFeedStore.getState().setManifest(mine.channelID, published)

    const own: FeedEntry = {
      item: published.items[0],
      channel: {
        authorHandle: '',
        authorDidDht: SOURCE,
        channelID: mine.channelID,
        name: 'My channel',
      },
    }
    render(
      <EngagementRow
        input={{
          item: own.item,
          channel: {
            authorHandle: '',
            channelID: mine.channelID,
            name: 'My channel',
          },
        }}
        entry={own}
      />,
    )
    // The only channel this identity owns is the one holding the post, so there is
    // nowhere left to send it.
    expect(screen.queryByRole('button', { name: 'Repost' })).toBeNull()
  })
})
