// Reading a portal along the source author's floor rung — the whole chain a repost
// resolves through, with nothing subscribed and nothing cached:
//
//   did:dht -> `_dir` -> their directory -> K -> the channel locator -> the item
//
// The point of driving it end to end is that each of the four outcomes is a DIFFERENT
// place in that chain giving out, and three of them look alike from the outside. A
// reader that couldn't tell them apart would either show a retracted post forever or
// drop a live one over a slow DHT.

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

import { deletePublishedItem } from '../core/channels'
import { channelKeyFromBase64 } from '../core/crypto'
import { portalKey } from '../core/feed'
import { DIRECTORY_DOC_VERSION } from '../core/identityDoc'
import type { ChannelManifest, ItemRef } from '../core/types'
import {
  commitChannelManifest,
  resolveChannelViaLocator,
} from '../lib/channelLocator'
import { readTally, warmChannelTallies } from '../lib/channelTallies'
import {
  commentRepostTargetFor,
  type HeldChannels,
  isPermanent,
  makePortalResolver,
  targetOf,
} from '../lib/repost'
import {
  fakeDocStore as docStore,
  publishFakeDirectory,
  publishFakeTallies,
  unpublishFakeDirectory,
  unpublishFakeLocator,
} from './fakeModules'
import {
  authorCreateChannel,
  createFakeApp,
  FAKE_APP_KEY_HEX,
  type FakeAccount,
  publishTextPost,
  resetAllStores,
} from './setupFakeApp'

const SOURCE_DID = 'did:dht:sourceauthor'

type Channel = { channelID: string; channelKey: string }

/** What the source author publishes about themselves. `channels` is where K comes from,
 *  and so it is the whole of what makes their content reachable. */
async function advertise(channels: Channel[]) {
  await publishFakeDirectory(SOURCE_DID, {
    version: DIRECTORY_DOC_VERSION,
    profile: null,
    channels: channels.map((c) => ({
      channelID: c.channelID,
      key: c.channelKey,
      name: 'Their channel',
    })),
    follows: [],
    handleFollows: [],
    updatedAt: new Date().toISOString(),
  })
}

/** A source author with one advertised channel holding one post — the arrangement every
 *  case below starts from and then breaks somewhere different. */
async function aChannelWorthReposting(author: FakeAccount) {
  const channel = await authorCreateChannel(author, { name: 'Their channel' })
  const item = await publishTextPost(author, channel, 'worth circulating')
  await advertise([channel])
  return { channel, item }
}

function portal(channelID: string, item: ItemRef) {
  return targetOf({
    didDht: SOURCE_DID,
    channelID,
    publishedAt: item.publishedAt,
    repostedAt: new Date().toISOString(),
  })
}

const COMMENTER = 'did:dht:bob'
const SAID_AT = '2026-08-24T09:00:00.000Z'

/** The same portal, narrowed to one comment on that post. */
function commentPortal(channelID: string, item: ItemRef) {
  return targetOf({
    didDht: SOURCE_DID,
    channelID,
    publishedAt: item.publishedAt,
    repostedAt: new Date().toISOString(),
    comment: { actor: COMMENTER, createdAt: SAID_AT },
  })
}

/** What the HOST publishes on that post — the only place a comment portal reads from. */
function hostPublishes(
  bodies: { actor: string; createdAt: string; body: string }[],
) {
  return async () =>
    bodies.map((b) => ({
      kind: 'comment',
      actor: b.actor,
      subject: 'sub',
      version: 'bafkreiabc',
      createdAt: b.createdAt,
      sig: `sig-${b.createdAt}`,
      body: b.body,
    }))
}

describe('integration: resolving a portal', () => {
  let app: ReturnType<typeof createFakeApp>
  let author: FakeAccount
  let reader: FakeAccount

  beforeEach(() => {
    resetAllStores()
    app = createFakeApp()
    author = app.createAccount({ did: 'did:src', handle: 'src' })
    // A different account holding no subscription and no key: everything the reader
    // learns, it learns from the author's own published directory.
    reader = app.createAccount({ did: 'did:reader', handle: 'reader' })
  })

  it('reads the post through the directory, with nothing subscribed', async () => {
    const { channel, item } = await aChannelWorthReposting(author)

    const outcome = await makePortalResolver(reader.client).resolve(
      portal(channel.channelID, item),
    )

    expect(outcome.state).toBe('resolved')
    if (outcome.state !== 'resolved') return
    expect(outcome.item.summary).toBe('worth circulating')
    expect(outcome.source.name).toBe('Their channel')
    expect(outcome.source.channelKey).toBe(channel.channelKey)
    expect(outcome.source.authorDidDht).toBe(SOURCE_DID)
  })

  it('reads a comment through the host that publishes it', async () => {
    // Through the HOST, never the commenter's own records: resolving from the commenter
    // would circulate a comment the host had declined, rendered as though it sat on their
    // post.
    const { channel, item } = await aChannelWorthReposting(author)

    const outcome = await makePortalResolver(
      reader.client,
      () => null,
      () => {},
      hostPublishes([
        { actor: COMMENTER, createdAt: SAID_AT, body: 'worth repeating' },
      ]),
    ).resolve(commentPortal(channel.channelID, item))

    expect(outcome.state).toBe('resolved')
    if (outcome.state !== 'resolved') return
    // The post comes too: a comment lifted out of its thread needs the post for context,
    // and the portal resolves both in one pass.
    expect(outcome.item.summary).toBe('worth circulating')
    expect(outcome.comment?.body).toBe('worth repeating')
    expect(outcome.comment?.actor).toBe(COMMENTER)
  })

  it('reports a comment the host no longer publishes as unpublished, not deleted', async () => {
    // Retryable, and that is the difference from a retracted post: a comment's address is
    // derived from who wrote it and when, so nobody can reassign it and one put back comes
    // back where it was. Neutral about WHY — the commenter withdrawing it and the host
    // declining it are indistinguishable from out here.
    const { channel, item } = await aChannelWorthReposting(author)

    const outcome = await makePortalResolver(
      reader.client,
      () => null,
      () => {},
      hostPublishes([
        {
          actor: 'did:dht:someone-else',
          createdAt: SAID_AT,
          body: 'a different remark',
        },
      ]),
    ).resolve(commentPortal(channel.channelID, item))

    expect(outcome.state).toBe('unpublished')
    expect(isPermanent(outcome)).toBe(false)
  })

  it('reports an uncached conversation as unreachable rather than as an absence', async () => {
    // The ordinary first pass over a cold portal: the post resolves, the warm that fetches
    // the host's conversations is still in flight, and nothing has been read. Converting
    // that into "the host is not publishing it" is the mistake this codebase has made three
    // times.
    const { channel, item } = await aChannelWorthReposting(author)

    const outcome = await makePortalResolver(
      reader.client,
      () => null,
      () => {},
      async () => null,
    ).resolve(commentPortal(channel.channelID, item))

    expect(outcome.state).toBe('unreachable')
  })

  it('leaves a portal to the post itself alone', async () => {
    // Every portal published before comments existed names no comment, so the conversation
    // must never be consulted for one — and a host publishing nothing must not make an
    // ordinary repost unreadable.
    const { channel, item } = await aChannelWorthReposting(author)
    let asked = false

    const outcome = await makePortalResolver(
      reader.client,
      () => null,
      () => {},
      async () => {
        asked = true
        return null
      },
    ).resolve(portal(channel.channelID, item))

    expect(outcome.state).toBe('resolved')
    expect(asked).toBe(false)
  })

  it('reports a retracted post as deleted', async () => {
    const { channel, item } = await aChannelWorthReposting(author)
    const current = await resolveOrThrow(channel)
    const { manifest } = await deletePublishedItem(current, item.id)
    await commitChannelManifest(
      author.client,
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
      manifest,
    )

    const outcome = await makePortalResolver(reader.client).resolve(
      portal(channel.channelID, item),
    )
    expect(outcome.state).toBe('deleted')
  })

  it('reports an un-advertised channel as unavailable', async () => {
    // The post is still there and still readable BY K. What changed is that the author
    // stopped handing K out, which is access withdrawal and is reversible — so it must
    // not read as the retraction that never comes back.
    const { channel, item } = await aChannelWorthReposting(author)
    await advertise([])

    const outcome = await makePortalResolver(reader.client).resolve(
      portal(channel.channelID, item),
    )
    expect(outcome.state).toBe('unavailable')
  })

  it('advertising the channel again brings the post back', async () => {
    const { channel, item } = await aChannelWorthReposting(author)
    await advertise([])
    await advertise([channel])

    const outcome = await makePortalResolver(reader.client).resolve(
      portal(channel.channelID, item),
    )
    expect(outcome.state).toBe('resolved')
  })

  it('reports an unreachable directory as unreachable', async () => {
    // Nothing was read, so nothing is known. Converting that into an absence is the
    // mistake this codebase has already made three times.
    const { channel, item } = await aChannelWorthReposting(author)
    unpublishFakeDirectory(SOURCE_DID)

    const outcome = await makePortalResolver(reader.client).resolve(
      portal(channel.channelID, item),
    )
    expect(outcome.state).toBe('unreachable')
  })

  it('reports an unresolvable channel pointer as unreachable', async () => {
    // The directory answered, so K is in hand — but the channel's own pointer did not.
    // On the real DHT that is ordinary propagation lag.
    const { channel, item } = await aChannelWorthReposting(author)
    unpublishFakeLocator(channelKeyFromBase64(channel.channelKey))

    const outcome = await makePortalResolver(reader.client).resolve(
      portal(channel.channelID, item),
    )
    expect(outcome.state).toBe('unreachable')
  })

  it('reads one directory for many portals into one author', async () => {
    // Cost scales with distinct SOURCES rather than with portal count. Without the
    // resolver's memo a feed carrying ten portals into one channel would pay ten
    // directory reads for what is one.
    const { channel } = await aChannelWorthReposting(author)
    const second = await publishTextPost(author, channel, 'and this one')
    const third = await publishTextPost(author, channel, 'and this')

    const downloads = vi.spyOn(reader.client, 'downloadItem')
    const resolver = makePortalResolver(reader.client)
    const outcomes = await Promise.all([
      resolver.resolve(portal(channel.channelID, second)),
      resolver.resolve(portal(channel.channelID, third)),
    ])

    expect(outcomes.map((o) => o.state)).toEqual(['resolved', 'resolved'])
    // The directory blob, once. The manifest doesn't come through the client at all —
    // the locator round-trip is Rust — so this counts the read the resolver itself makes.
    expect(downloads).toHaveBeenCalledTimes(1)
  })
})

/** The channel's manifest as published, for a case that needs to rewrite it. */
async function resolveOrThrow(channel: Channel) {
  const manifest = await resolveChannelViaLocator(channel.channelKey)
  if (!manifest) throw new Error('channel not resolvable')
  return manifest
}

describe('integration: resolving a portal into a channel the reader already holds', () => {
  let app: ReturnType<typeof createFakeApp>
  let author: FakeAccount
  let reader: FakeAccount

  beforeEach(() => {
    resetAllStores()
    app = createFakeApp()
    author = app.createAccount({ did: 'did:src', handle: 'src' })
    reader = app.createAccount({ did: 'did:reader', handle: 'reader' })
  })

  /** The reader's own K for that channel, which is what a subscription is. */
  function subscribedTo(channel: Channel): HeldChannels {
    return ({ channelID }) =>
      channelID === channel.channelID
        ? { channelKey: channel.channelKey }
        : null
  }

  it('reads it with no directory at all', async () => {
    // A subscriber holds K. Asking the author's directory for it answers a question
    // nobody asked, and this is the case where doing so gets it WRONG.
    const { channel, item } = await aChannelWorthReposting(author)
    unpublishFakeDirectory(SOURCE_DID)

    const outcome = await makePortalResolver(
      reader.client,
      subscribedTo(channel),
    ).resolve(portal(channel.channelID, item))

    expect(outcome.state).toBe('resolved')
  })

  it('reads it even when the author advertises nothing', async () => {
    // THE BUG. Un-advertising revokes DISCOVERY, not access for somebody who was already
    // given the key — and a directory merely lagging behind looks identical from here.
    // Reporting this as unavailable told a reposter their own post had gone.
    const { channel, item } = await aChannelWorthReposting(author)
    await advertise([])

    const outcome = await makePortalResolver(
      reader.client,
      subscribedTo(channel),
    ).resolve(portal(channel.channelID, item))

    expect(outcome.state).toBe('resolved')
  })

  it('still reports a retract, which holding K cannot argue with', async () => {
    const { channel, item } = await aChannelWorthReposting(author)
    const current = await resolveOrThrow(channel)
    const { manifest } = await deletePublishedItem(current, item.id)
    await commitChannelManifest(
      author.client,
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
      manifest,
    )

    const outcome = await makePortalResolver(
      reader.client,
      subscribedTo(channel),
    ).resolve(portal(channel.channelID, item))

    expect(outcome.state).toBe('deleted')
  })

  it('reads a manifest already in hand without touching the network', async () => {
    // Which is what makes a portal to one of your OWN posts free.
    const { channel, item } = await aChannelWorthReposting(author)
    const inHand = await resolveOrThrow(channel)
    unpublishFakeDirectory(SOURCE_DID)
    unpublishFakeLocator(channelKeyFromBase64(channel.channelKey))

    const downloads = vi.spyOn(reader.client, 'downloadItem')
    const outcome = await makePortalResolver(reader.client, () => ({
      channelKey: channel.channelKey,
      manifest: inHand,
    })).resolve(portal(channel.channelID, item))

    expect(outcome.state).toBe('resolved')
    expect(downloads).not.toHaveBeenCalled()
  })

  it('falls to the author for a channel it holds nothing for', async () => {
    // The two rungs coexist: holding nothing is the case the directory read is for.
    const { channel, item } = await aChannelWorthReposting(author)
    await advertise([])

    const outcome = await makePortalResolver(reader.client, () => null).resolve(
      portal(channel.channelID, item),
    )

    expect(outcome.state).toBe('unavailable')
  })
})

describe('integration: a portal brings the source’s counts with it', () => {
  let app: ReturnType<typeof createFakeApp>
  let author: FakeAccount
  let reader: FakeAccount

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    app = createFakeApp()
    author = app.createAccount({ did: 'did:src', handle: 'src' })
    reader = app.createAccount({ did: 'did:reader', handle: 'reader' })
  })

  /** What the source author's own fold published about one of their posts. */
  async function theyCount(channel: Channel, item: ItemRef, count: number) {
    const { engagement_subject } = await import(
      '../../crates/pin-core/pkg/pin_core.js'
    )
    publishFakeTallies(channelKeyFromBase64(channel.channelKey), {
      [engagement_subject(channel.channelID, item.publishedAt, undefined)]: {
        kinds: {
          like: { count, setRoot: 'root-a', sampleActors: ['did:dht:bob'] },
        },
        updatedAt: item.publishedAt,
      },
    })
  }

  /** A resolver warming counts for real, plus the reads to wait on. A row reads the
   *  cache rather than the callback, so a test has to let the write land. */
  function warming(held: HeldChannels = () => null) {
    const reads: Promise<void>[] = []
    const resolver = makePortalResolver(
      reader.client,
      held,
      (channelID, channelKey) => {
        reads.push(warmChannelTallies(FAKE_APP_KEY_HEX, channelID, channelKey))
      },
    )
    return { resolver, reads, settled: () => Promise.all(reads) }
  }

  it('caches them for a channel it holds nothing for', async () => {
    // The gap: no loop this identity runs covers a stranger's channel, so nothing else
    // would ever write its counts and the row would render bare beside a post whose
    // counts are plainly published.
    const { channel, item } = await aChannelWorthReposting(author)
    await theyCount(channel, item, 3)

    const { resolver, settled } = warming()
    const outcome = await resolver.resolve(portal(channel.channelID, item))
    await settled()

    expect(outcome.state).toBe('resolved')
    // Read by the item the way a row does, and under the ORIGINAL's channel — which is
    // whose post a portal renders, and so whose subject its counts are filed under.
    const tally = await readTally(FAKE_APP_KEY_HEX, {
      channelID: channel.channelID,
      publishedAt: item.publishedAt,
    })
    expect(tally?.kinds.like?.count).toBe(3)
  })

  it('reads one channel’s counts once for many portals into it', async () => {
    const { channel, item } = await aChannelWorthReposting(author)
    const second = await publishTextPost(author, channel, 'and this one')

    const { resolver, reads } = warming()
    await Promise.all([
      resolver.resolve(portal(channel.channelID, item)),
      resolver.resolve(portal(channel.channelID, second)),
    ])

    // Counts are published per channel rather than per post, so one read serves both
    // rows — the same amortization the directory and manifest memos are for.
    expect(reads).toHaveLength(1)
  })

  it('leaves a channel it already holds to the pass that covers it', async () => {
    // A subscription's counts arrive through the pull loop and an owned channel's
    // through the engagement loop. Reading them here would spend a DHT resolve and a
    // Sia download on work already done.
    const { channel, item } = await aChannelWorthReposting(author)

    const { resolver, reads } = warming(() => ({
      channelKey: channel.channelKey,
    }))
    const outcome = await resolver.resolve(portal(channel.channelID, item))

    expect(outcome.state).toBe('resolved')
    expect(reads).toHaveLength(0)
  })

  it('asks for none when the post it names is gone', async () => {
    // The manifest WAS read here, so the channel is reachable and the cheap condition
    // would fire — but a retracted post has no row, and counts are for a row.
    const { channel, item } = await aChannelWorthReposting(author)
    const current = await resolveOrThrow(channel)
    const { manifest } = await deletePublishedItem(current, item.id)
    await commitChannelManifest(
      author.client,
      FAKE_APP_KEY_HEX,
      channel.channelID,
      channel.channelKey,
      manifest,
    )

    const { resolver, reads } = warming()
    const outcome = await resolver.resolve(portal(channel.channelID, item))

    expect(outcome.state).toBe('deleted')
    expect(reads).toHaveLength(0)
  })
})

describe('integration: what may be circulated', () => {
  const POST = {
    channelID: 'host-chan',
    publishedAt: '2026-08-24T08:00:00.000Z',
  }
  const SAID = { actor: COMMENTER, createdAt: SAID_AT }

  // No default on `authorDidDht`: a default replaces an explicitly-passed `undefined`, so
  // the "no author to resolve through" case would silently become the ordinary one.
  function host(
    visibility: 'public' | 'obscure' | undefined,
    authorDidDht: string | undefined,
  ) {
    return {
      [POST.channelID]: {
        version: 1,
        name: 'Their channel',
        description: '',
        authorPubkey: 'ed25519:aa',
        authorDidDht,
        publishedAt: POST.publishedAt,
        visibility,
        items: [],
      } as unknown as ChannelManifest,
    }
  }

  it('circulates a comment out of a public channel', async () => {
    expect(
      commentRepostTargetFor(SAID, POST, host('public', 'did:dht:host')),
    ).toEqual({
      didDht: 'did:dht:host',
      channelID: POST.channelID,
      publishedAt: POST.publishedAt,
      comment: SAID,
    })
  })

  it('refuses to circulate one out of a channel that is not public', async () => {
    // Twitter's and Mastodon's behaviour, and here it is self-enforcing rather than policy:
    // an unlisted channel is not in its author's directory, so a portal to one has nothing
    // to resolve through. Hiding the gesture is honesty about a refusal the mechanism
    // already makes.
    expect(
      commentRepostTargetFor(SAID, POST, host('obscure', 'did:dht:host')),
    ).toBeNull()
    // Absent visibility reads as not-public, the safe direction every reader here takes.
    expect(
      commentRepostTargetFor(SAID, POST, host(undefined, 'did:dht:host')),
    ).toBeNull()
  })

  it('refuses when the host channel is unknown or has no author to resolve through', async () => {
    expect(commentRepostTargetFor(SAID, POST, {})).toBeNull()
    expect(
      commentRepostTargetFor(SAID, POST, host('public', undefined)),
    ).toBeNull()
  })

  it('keys a post and a comment on it apart', async () => {
    // Same collision the manifest address had, one layer up: these key the resolved-portal
    // cache and the menu's idea of which of your channels already carry it, so sharing a key
    // would hold one where two belong.
    const post = {
      didDht: 'did:dht:host',
      channelID: POST.channelID,
      publishedAt: POST.publishedAt,
    }
    expect(portalKey(post)).not.toBe(portalKey({ ...post, comment: SAID }))
    // And a post's key is exactly what it always was, so nothing already keyed moves.
    expect(portalKey(post)).toBe(
      `did:dht:host/${POST.channelID}/${POST.publishedAt}`,
    )
  })
})
