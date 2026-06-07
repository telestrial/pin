import { describe, expect, it, vi } from 'vitest'
import { buildHomeFeed, type FetchChannel } from './feed'
import type {
  ChannelManifest,
  ItemRef,
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
    expect(result.entries[0].item.summary).toBe('body at 2026-05-01T10:00:00.000Z')
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
      .mockResolvedValueOnce(manifest('Alice', [item('2026-05-01T00:00:00.000Z')]))
      .mockRejectedValueOnce(new Error('record not found'))
    const result = await buildHomeFeed(
      [
        sub({ channelID: 'aaaa' }),
        sub({ authorHandle: 'broken.test', channelID: 'bbbb', label: 'Broken' }),
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

  it('coerces non-Error rejections to a string', async () => {
    const fetcher: FetchChannel = vi.fn().mockRejectedValue('plain string failure')
    const result = await buildHomeFeed([sub()], fetcher)
    expect(result.errors[0].error).toBe('plain string failure')
  })

  it('prefers authorDID over authorHandle when calling the fetcher', async () => {
    const fetcher: FetchChannel = vi.fn().mockResolvedValue(manifest('Alice', []))
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
    )
  })

  it('falls back to authorHandle when authorDID is empty', async () => {
    const fetcher: FetchChannel = vi.fn().mockResolvedValue(manifest('Alice', []))
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
    )
  })
})
