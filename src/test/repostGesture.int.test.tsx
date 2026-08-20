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

import {
  endorsement_verify,
  engagement_subject,
  tally_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
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

const pickOne = (name: RegExp) =>
  userEvent.click(screen.getByRole('menuitemcheckbox', { name }))

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

  it('marks the gesture as pressed once any channel carries it', async () => {
    // The semantic half of the icon lighting up. The colour is a class string and not
    // worth asserting; this is the part a screen reader depends on and the part that
    // would silently stop being true.
    const { mine } = await withOwnChannel(app)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    expect(repostButton()).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(repostButton())
    await pickOne(/My channel/)
    await waitFor(async () => {
      expect(
        (await resolveChannelViaLocator(mine.channelKey))?.reposts,
      ).toHaveLength(1)
    })
    expect(repostButton()).toHaveAttribute('aria-pressed', 'true')
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

  it('keeps the gesture and says why, with no channel of its own', async () => {
    // Taking the button away would take the COUNT with it, and the count is everybody's
    // — it says nothing about whether this identity can repost.
    const me = app.createAccount({ did: 'did:plc:me', handle: 'me.test' })
    mountAs(me)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    expect(screen.getByText(/Create a channel to repost/)).toBeInTheDocument()
  })

  it('does not offer the channel a post is already in', async () => {
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
    // nowhere left to send it — which the menu says rather than the gesture disappearing.
    await userEvent.click(repostButton())
    expect(
      screen.getByText(/No other channel to repost this to/),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitemcheckbox', { name: /My channel/ }),
    ).toBeNull()
  })
})

// --- the endorsement behind the count ----------------------------------------------
//
// A repost is ONE endorsement however many of your channels carry the post, because an
// endorsement is per actor: the number a reader sees is reposters, not reposts. So it
// turns on with the first channel and off with the last, and the two channels in between
// change nothing about it.

const repostRecords = () =>
  [...docStore.keys()].filter((k) => k.startsWith('endorse/repost:'))

/** Sign in with two channels, so "first" and "last" are distinguishable. */
async function withTwoChannels(app: ReturnType<typeof createFakeApp>) {
  const me = app.createAccount({ did: 'did:plc:me', handle: 'me.test' })
  const first = await authorCreateChannel(me, { name: 'First channel' })
  const second = await authorCreateChannel(me, { name: 'Second channel' })
  mountAs(me, {
    myChannels: [
      {
        channelID: first.channelID,
        channelKey: first.channelKey,
        name: 'First channel',
      },
      {
        channelID: second.channelID,
        channelKey: second.channelKey,
        name: 'Second channel',
      },
    ],
  })
  useFeedStore.getState().setManifest(first.channelID, first.manifest)
  useFeedStore.getState().setManifest(second.channelID, second.manifest)
  return { me, first, second }
}

const pick = (name: RegExp) =>
  userEvent.click(screen.getByRole('menuitemcheckbox', { name }))

describe('integration: the endorsement behind a repost count', () => {
  let app: ReturnType<typeof createFakeApp>

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    app = createFakeApp()
  })

  it('records one endorsement for the first channel to carry it', async () => {
    await withTwoChannels(app)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    await pick(/First channel/)

    await waitFor(() => expect(repostRecords()).toHaveLength(1))
  })

  it('records no second endorsement for a second channel', async () => {
    // Reposting into three of your own channels is still one reposter.
    await withTwoChannels(app)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    await pick(/First channel/)
    await waitFor(() => expect(repostRecords()).toHaveLength(1))
    await pick(/Second channel/)
    await waitFor(() =>
      expect(
        screen.getByRole('menuitemcheckbox', { name: /Second channel/ }),
      ).toHaveAttribute('aria-checked', 'true'),
    )

    expect(repostRecords()).toHaveLength(1)
  })

  it('keeps the endorsement while any channel still carries it', async () => {
    await withTwoChannels(app)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    await pick(/First channel/)
    await pick(/Second channel/)
    await waitFor(() =>
      expect(
        screen.getByRole('menuitemcheckbox', { name: /Second channel/ }),
      ).toHaveAttribute('aria-checked', 'true'),
    )

    await pick(/First channel/)
    await waitFor(() =>
      expect(
        screen.getByRole('menuitemcheckbox', { name: /First channel/ }),
      ).toHaveAttribute('aria-checked', 'false'),
    )
    expect(repostRecords()).toHaveLength(1)
  })

  it('withdraws the endorsement with the last channel', async () => {
    await withTwoChannels(app)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    await pick(/First channel/)
    await waitFor(() => expect(repostRecords()).toHaveLength(1))

    await pick(/First channel/)
    await waitFor(() => expect(repostRecords()).toHaveLength(0))
  })

  it('signs a record a fold would count', async () => {
    // The same bar as a like: the fold verifies every record it counts, so one this
    // identity cannot be shown to have made is one that will never appear in a tally.
    await withTwoChannels(app)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await userEvent.click(repostButton())
    await pick(/First channel/)
    await waitFor(() => expect(repostRecords()).toHaveLength(1))

    const stored = docStore.get(repostRecords()[0])
    if (!stored) throw new Error('no record')
    const record = new TextDecoder().decode(stored)
    expect(JSON.parse(record).kind).toBe('repost')
    expect(() => endorsement_verify(record)).not.toThrow()
  })
})

// --- what the number beside the recycle means -------------------------------------

/** Put a repost count in the cache the way the Curator's loops would. */
function cacheRepostCount(n: number) {
  const subject = engagement_subject(SRC_CHANNEL, POST_AT, undefined)
  docStore.set(
    `tally/${tally_rkey(SRC_CHANNEL, subject)}`,
    new TextEncoder().encode(
      JSON.stringify({
        kinds: { repost: { count: n, setRoot: 'root', sampleActors: [] } },
        updatedAt: '2099-01-01T00:00:00.000Z',
      }),
    ),
  )
}

describe('integration: the repost count', () => {
  let app: ReturnType<typeof createFakeApp>

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    app = createFakeApp()
  })

  it('shows how many identities circulate it, not how many of your channels do', async () => {
    // The distinction the whole actor-keyed model rests on. Your own channels are the
    // checkmarks in the menu; the number is everybody, and it comes from the author's
    // published tally the same way the heart's and the pin's do.
    await withTwoChannels(app)
    knowSourceIsPublic()
    cacheRepostCount(7)

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument())

    await userEvent.click(repostButton())
    await pick(/First channel/)
    await waitFor(() =>
      expect(
        screen.getByRole('menuitemcheckbox', { name: /First channel/ }),
      ).toHaveAttribute('aria-checked', 'true'),
    )

    // Still the author's number. One of two channels carrying it is not the count.
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.queryByText('1')).toBeNull()
  })

  it('shows nothing when nobody circulates it', async () => {
    // Absent and zero read the same to a reader, and absent is by far the more common.
    await withTwoChannels(app)
    knowSourceIsPublic()

    render(<EngagementRow input={INPUT} entry={theirPost()} />)
    expect(screen.queryByText('0')).toBeNull()
  })
})

describe('integration: circulating your own post', () => {
  let app: ReturnType<typeof createFakeApp>

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    app = createFakeApp()
  })

  it('offers your other channels for a post in one of them', async () => {
    // Posting to one voice and circulating through another is a headline use of
    // channel-as-voice, so a post in your own channel carries the gesture like any other.
    const { me, first, second } = await withTwoChannels(app)
    await publishTextPost(me, first, 'my own post')
    const published = await resolveChannelViaLocator(first.channelKey)
    if (!published) throw new Error('not resolvable')
    useFeedStore.getState().setManifest(first.channelID, published)

    const mine: FeedEntry = {
      item: published.items[0],
      channel: {
        authorHandle: '',
        authorDidDht: 'did:dht:me',
        channelID: first.channelID,
        name: 'First channel',
      },
    }
    render(
      <EngagementRow
        input={{
          item: mine.item,
          channel: {
            authorHandle: '',
            channelID: first.channelID,
            name: 'First channel',
          },
        }}
        entry={mine}
      />,
    )

    await userEvent.click(repostButton())
    // The other one is offered; the one it is already in is not.
    expect(
      screen.getByRole('menuitemcheckbox', { name: /Second channel/ }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitemcheckbox', { name: /First channel/ }),
    ).toBeNull()

    await pick(/Second channel/)
    await waitFor(async () => {
      const after = await resolveChannelViaLocator(second.channelKey)
      expect(after?.reposts).toHaveLength(1)
    })
  })
})
