import { describe, expect, it, vi } from 'vitest'
import {
  buildHomeFeed,
  contributingChannelOf,
  entriesForManifest,
  type FetchChannel,
  feedTimeOf,
  portalKey,
  portalsIn,
  type ResolvedPortalEntry,
} from './feed'
import type {
  ChannelManifest,
  ItemRef,
  RepostRef,
  SubscriptionRef,
} from './types'

function sub(overrides: Partial<SubscriptionRef> = {}): SubscriptionRef {
  return {
    authorHandle: 'alice.test',
    authorDID: 'did:plc:alice',
    channelID: 'alicechannel0001',
    channelKey: 'AAAA',
    addedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

function item(publishedAt: string, overrides: Partial<ItemRef> = {}): ItemRef {
  return {
    id: `id-${publishedAt}`,
    itemURL: `https://sia.test/${publishedAt}`,
    type: 'text',
    title: '',
    summary: `body at ${publishedAt}`,
    publishedAt,
    mimeType: 'text/markdown',
    byteSize: 32,
    ...overrides,
  }
}

function manifest(
  name: string,
  items: ItemRef[],
  overrides: Partial<ChannelManifest> = {},
): ChannelManifest {
  return {
    version: 1,
    name,
    description: '',
    authorPubkey: 'pubkey',
    authorATProtoDID: 'did:plc:alice',
    publishedAt: '2026-05-01T00:00:00.000Z',
    items,
    ...overrides,
  }
}

describe('buildHomeFeed', () => {
  it('returns empty results for an empty subscription list', async () => {
    const fetcher: FetchChannel = vi.fn()
    const result = await buildHomeFeed([], fetcher)
    expect(result.entries).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.manifests).toEqual({})
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("threads each item into a FeedEntry with the channel's identity", async () => {
    const fetcher: FetchChannel = vi.fn().mockResolvedValue(
      manifest('Alice', [item('2026-05-01T10:00:00.000Z')], {
        avatar: { itemURL: 'https://sia.test/avatar', mimeType: 'image/jpeg' },
      }),
    )
    const result = await buildHomeFeed([sub()], fetcher)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].channel).toEqual({
      authorHandle: 'alice.test',
      channelID: 'alicechannel0001',
      name: 'Alice',
      avatar: { itemURL: 'https://sia.test/avatar', mimeType: 'image/jpeg' },
    })
    expect(result.entries[0].item.summary).toBe(
      'body at 2026-05-01T10:00:00.000Z',
    )
  })

  it('sorts entries newest-first by publishedAt across multiple channels', async () => {
    const fetcher: FetchChannel = vi
      .fn()
      .mockResolvedValueOnce(
        manifest('Alice', [
          item('2026-05-01T10:00:00.000Z'),
          item('2026-05-03T10:00:00.000Z'),
        ]),
      )
      .mockResolvedValueOnce(
        manifest('Bob', [
          item('2026-05-02T10:00:00.000Z'),
          item('2026-05-04T10:00:00.000Z'),
        ]),
      )
    const result = await buildHomeFeed(
      [sub(), sub({ authorHandle: 'bob.test', channelID: 'bobchannel000001' })],
      fetcher,
    )
    expect(result.entries.map((e) => e.item.publishedAt)).toEqual([
      '2026-05-04T10:00:00.000Z',
      '2026-05-03T10:00:00.000Z',
      '2026-05-02T10:00:00.000Z',
      '2026-05-01T10:00:00.000Z',
    ])
  })

  it('caches each fetched manifest by channelID', async () => {
    const fetcher: FetchChannel = vi
      .fn()
      .mockResolvedValueOnce(manifest('Alice', []))
      .mockResolvedValueOnce(manifest('Bob', []))
    const result = await buildHomeFeed(
      [
        sub({ channelID: 'aaaa' }),
        sub({ authorHandle: 'bob.test', channelID: 'bbbb' }),
      ],
      fetcher,
    )
    expect(Object.keys(result.manifests).sort()).toEqual(['aaaa', 'bbbb'])
    expect(result.manifests.aaaa.name).toBe('Alice')
    expect(result.manifests.bbbb.name).toBe('Bob')
  })

  it('captures a fetch failure as an error entry without breaking the others', async () => {
    const fetcher: FetchChannel = vi
      .fn()
      .mockResolvedValueOnce(
        manifest('Alice', [item('2026-05-01T00:00:00.000Z')]),
      )
      .mockRejectedValueOnce(new Error('record not found'))
    const result = await buildHomeFeed(
      [
        sub({ channelID: 'aaaa' }),
        sub({
          authorHandle: 'broken.test',
          channelID: 'bbbb',
          label: 'Broken',
        }),
      ],
      fetcher,
    )
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].channel.channelID).toBe('aaaa')
    expect(result.errors).toEqual([
      {
        authorHandle: 'broken.test',
        channelID: 'bbbb',
        label: 'Broken',
        error: 'record not found',
      },
    ])
    // A failed sub's manifest is not in the cache.
    expect(result.manifests.bbbb).toBeUndefined()
  })

  it('keeps last-known content when a re-resolve fails but a manifest is cached', async () => {
    const fetcher: FetchChannel = vi
      .fn()
      .mockRejectedValueOnce(new Error('object not found'))
    const cached = manifest('Alice', [item('2026-05-01T00:00:00.000Z')])
    const result = await buildHomeFeed([sub({ channelID: 'aaaa' })], fetcher, {
      aaaa: cached,
    })
    // Stale-while-revalidate: the channel stays in the feed, no error surfaced.
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].channel.channelID).toBe('aaaa')
    expect(result.errors).toEqual([])
    expect(result.manifests.aaaa).toBe(cached)
  })

  it('errors a failed re-resolve only when there is no cached manifest', async () => {
    const fetcher: FetchChannel = vi
      .fn()
      .mockRejectedValueOnce(new Error('object not found'))
    const result = await buildHomeFeed(
      [sub({ channelID: 'aaaa' })],
      fetcher,
      {},
    )
    expect(result.entries).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].channelID).toBe('aaaa')
  })

  it('coerces non-Error rejections to a string', async () => {
    const fetcher: FetchChannel = vi
      .fn()
      .mockRejectedValue('plain string failure')
    const result = await buildHomeFeed([sub()], fetcher)
    expect(result.errors[0].error).toBe('plain string failure')
  })

  it('prefers authorDID over authorHandle when calling the fetcher', async () => {
    const fetcher: FetchChannel = vi
      .fn()
      .mockResolvedValue(manifest('Alice', []))
    await buildHomeFeed(
      [
        sub({
          authorHandle: 'alice.test',
          authorDID: 'did:plc:alice',
        }),
      ],
      fetcher,
    )
    expect(fetcher).toHaveBeenCalledWith(
      'did:plc:alice',
      'alicechannel0001',
      'AAAA',
      false,
    )
  })

  it('falls back to authorHandle when authorDID is empty', async () => {
    const fetcher: FetchChannel = vi
      .fn()
      .mockResolvedValue(manifest('Alice', []))
    await buildHomeFeed(
      [
        sub({
          authorHandle: 'alice.test',
          authorDID: '',
        }),
      ],
      fetcher,
    )
    expect(fetcher).toHaveBeenCalledWith(
      'alice.test',
      'alicechannel0001',
      'AAAA',
      false,
    )
  })

  it('forwards a fresh read to the fetcher', async () => {
    const fetcher: FetchChannel = vi
      .fn()
      .mockResolvedValue(manifest('Alice', []))
    await buildHomeFeed([sub({})], fetcher, {}, true)
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      'alicechannel0001',
      'AAAA',
      true,
    )
  })
})

// --- portals ------------------------------------------------------------------
//
// A portal is a post from somewhere else appearing in a channel that circulates it,
// so every question the collation asks has two possible answers — the original's or
// the circulator's — and each one has a place where only one of them is right.

const SOURCE = 'did:dht:sourceauthor'

function repost(overrides: Partial<RepostRef> = {}): RepostRef {
  return {
    didDht: SOURCE,
    channelID: 'srcchannel000001',
    publishedAt: '2026-05-01T09:00:00.000Z',
    repostedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  }
}

/** A portal that has been read, as the collation receives it. */
function resolved(
  target: RepostRef,
  overrides: Partial<ResolvedPortalEntry> = {},
): Record<string, ResolvedPortalEntry> {
  return {
    [portalKey(target)]: {
      item: item(target.publishedAt),
      channel: {
        authorHandle: '',
        authorDidDht: target.didDht,
        channelID: target.channelID,
        name: 'Their channel',
      },
      ...overrides,
    },
  }
}

describe('entriesForManifest', () => {
  it('shows a portal under the original identity, naming who circulated it', async () => {
    const target = repost()
    const entries = entriesForManifest(
      sub(),
      manifest('My channel', [], { reposts: [target] }),
      resolved(target),
    )

    expect(entries).toHaveLength(1)
    // Whose post it is.
    expect(entries[0].channel.channelID).toBe('srcchannel000001')
    expect(entries[0].channel.authorDidDht).toBe(SOURCE)
    // Who put it here.
    expect(entries[0].repost?.channel.channelID).toBe('alicechannel0001')
    expect(entries[0].repost?.at).toBe('2026-06-01T09:00:00.000Z')
  })

  it('leaves out a portal that has not resolved', async () => {
    const entries = entriesForManifest(
      sub(),
      manifest('My channel', [item('2026-05-02T00:00:00.000Z')], {
        reposts: [repost()],
      }),
      {},
    )
    // The channel's own post still shows: one unread portal does not cost the rest.
    expect(entries).toHaveLength(1)
    expect(entries[0].repost).toBeUndefined()
  })

  it('carries a channel own items and its portals together', async () => {
    const target = repost()
    const entries = entriesForManifest(
      sub(),
      manifest('My channel', [item('2026-05-02T00:00:00.000Z')], {
        reposts: [target],
      }),
      resolved(target),
    )
    expect(entries).toHaveLength(2)
  })
})

describe('feedTimeOf', () => {
  it('places a portal when it was circulated', async () => {
    // Otherwise reposting a year-old post drops it a year down the feed, where the
    // gesture may as well not have happened.
    const target = repost({
      publishedAt: '2025-01-01T00:00:00.000Z',
      repostedAt: '2026-06-01T09:00:00.000Z',
    })
    const [entry] = entriesForManifest(
      sub(),
      manifest('My channel', [], { reposts: [target] }),
      resolved(target),
    )
    expect(feedTimeOf(entry)).toBe('2026-06-01T09:00:00.000Z')
  })

  it('places an ordinary post when it was published', async () => {
    const [entry] = entriesForManifest(
      sub(),
      manifest('My channel', [item('2026-05-02T00:00:00.000Z')]),
    )
    expect(feedTimeOf(entry)).toBe('2026-05-02T00:00:00.000Z')
  })
})

describe('contributingChannelOf', () => {
  it('names the circulating channel for a portal', async () => {
    // The one that has it in its manifest, which is the one that can take it down.
    const target = repost()
    const [entry] = entriesForManifest(
      sub(),
      manifest('My channel', [], { reposts: [target] }),
      resolved(target),
    )
    expect(contributingChannelOf(entry).channelID).toBe('alicechannel0001')
  })

  it('names the channel itself for an ordinary post', async () => {
    const [entry] = entriesForManifest(
      sub(),
      manifest('My channel', [item('2026-05-02T00:00:00.000Z')]),
    )
    expect(contributingChannelOf(entry).channelID).toBe('alicechannel0001')
  })
})

describe('portalsIn', () => {
  it('counts one post circulated by two channels once', async () => {
    // Two portals, one thing to read. Without the dedup a popular post would be
    // fetched once per channel carrying it.
    const target = repost()
    const found = portalsIn({
      a: manifest('A', [], { reposts: [target] }),
      b: manifest('B', [], { reposts: [{ ...target, repostedAt: 'later' }] }),
    })
    expect(found).toHaveLength(1)
  })

  it('keeps two different posts from one source apart', async () => {
    const found = portalsIn({
      a: manifest('A', [], {
        reposts: [
          repost(),
          repost({ publishedAt: '2026-05-05T00:00:00.000Z' }),
        ],
      }),
    })
    expect(found).toHaveLength(2)
  })

  it('finds nothing in channels that circulate nothing', async () => {
    expect(
      portalsIn({ a: manifest('A', [item('2026-05-02T00:00:00.000Z')]) }),
    ).toHaveLength(0)
  })
})

describe('buildHomeFeed with portals', () => {
  it('interleaves a repost by when it was circulated', async () => {
    const target = repost({
      publishedAt: '2025-01-01T00:00:00.000Z',
      repostedAt: '2026-05-15T00:00:00.000Z',
    })
    const fetcher: FetchChannel = async () =>
      manifest(
        'My channel',
        [item('2026-05-10T00:00:00.000Z'), item('2026-05-20T00:00:00.000Z')],
        { reposts: [target] },
      )

    const result = await buildHomeFeed(
      [sub()],
      fetcher,
      {},
      false,
      resolved(target),
    )

    expect(result.entries.map(feedTimeOf)).toEqual([
      '2026-05-20T00:00:00.000Z',
      '2026-05-15T00:00:00.000Z',
      '2026-05-10T00:00:00.000Z',
    ])
  })
})
