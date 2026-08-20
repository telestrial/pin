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
import { DIRECTORY_DOC_VERSION } from '../core/identityDoc'
import type { ItemRef } from '../core/types'
import {
  commitChannelManifest,
  resolveChannelViaLocator,
} from '../lib/channelLocator'
import { type HeldChannels, makePortalResolver, targetOf } from '../lib/repost'
import {
  publishFakeDirectory,
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
