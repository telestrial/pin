import { describe, expect, it } from 'vitest'
import type { ChannelManifest, ItemRef } from '../core/types'
import { CHANNEL_MANIFEST_VERSION } from '../core/types'
import type { PinnedItemRef } from '../stores/pin'
import { channelPinByteSize, computeChannelPinState } from './useChannelPinState'

function item(publishedAt: string, contentHash?: string): ItemRef {
  return {
    id: `item-${publishedAt}`,
    itemURL: `sia://fake/${publishedAt}`,
    type: 'text',
    title: '',
    publishedAt,
    mimeType: 'text/markdown',
    byteSize: 100,
    contentHash,
  }
}

function pin(
  channelID: string,
  it: ItemRef,
  contentHash = it.contentHash,
): PinnedItemRef {
  return {
    item: { ...it, contentHash },
    channel: { authorHandle: 'alice', channelID, name: 'ch' },
    objectID: `obj-${it.publishedAt}`,
    pinnedAt: '2026-01-01T00:00:00.000Z',
  }
}

const CH = 'channel-a'
const a = item('2026-01-03T00:00:00.000Z', 'cidA')
const b = item('2026-01-02T00:00:00.000Z', 'cidB')
const c = item('2026-01-01T00:00:00.000Z', 'cidC')

describe('computeChannelPinState', () => {
  it('is pinnable for an empty channel', () => {
    expect(computeChannelPinState([], CH, [])).toBe('pinnable')
  })

  it('is pinnable when nothing in the channel is held', () => {
    expect(computeChannelPinState([a, b, c], CH, [])).toBe('pinnable')
  })

  it('is pinned when every current item is held at its current version', () => {
    const pinned = [pin(CH, a), pin(CH, b), pin(CH, c)]
    expect(computeChannelPinState([a, b, c], CH, pinned)).toBe('pinned')
  })

  it('is edited (behind) when a new item arrived that is not held', () => {
    const pinned = [pin(CH, b), pin(CH, c)] // a is new, unheld
    expect(computeChannelPinState([a, b, c], CH, pinned)).toBe('edited')
  })

  it('is edited when a held item drifted (contentHash differs)', () => {
    // Hold a's old version; channel now serves a new contentHash for a.
    const pinned = [pin(CH, a, 'cidA-old'), pin(CH, b), pin(CH, c)]
    expect(computeChannelPinState([a, b, c], CH, pinned)).toBe('edited')
  })

  it('ignores pins from other channels', () => {
    const pinned = [pin('other', a), pin('other', b)]
    expect(computeChannelPinState([a, b], CH, pinned)).toBe('pinnable')
  })

  it('treats legacy items without contentHash as held (no drift detectable)', () => {
    const la = item('2026-02-02T00:00:00.000Z') // no hash
    const lb = item('2026-02-01T00:00:00.000Z') // no hash
    const pinned = [pin(CH, la), pin(CH, lb)]
    expect(computeChannelPinState([la, lb], CH, pinned)).toBe('pinned')
  })

  it('a fully-drifted channel reads edited, not pinnable', () => {
    // Held everything, but every held copy is an old version.
    const pinned = [
      pin(CH, a, 'old'),
      pin(CH, b, 'old'),
      pin(CH, c, 'old'),
    ]
    expect(computeChannelPinState([a, b, c], CH, pinned)).toBe('edited')
  })
})

function manifest(over: Partial<ChannelManifest>): ChannelManifest {
  return {
    version: CHANNEL_MANIFEST_VERSION,
    name: 'ch',
    description: '',
    authorPubkey: 'pk',
    authorATProtoDID: 'did:test:alice',
    publishedAt: '2026-01-01T00:00:00.000Z',
    items: [],
    ...over,
  }
}

describe('channelPinByteSize', () => {
  it('sums item bodies', () => {
    const m = manifest({ items: [item('1'), item('2'), item('3')] })
    expect(channelPinByteSize(m)).toBe(300)
  })

  it('adds attachment bytes', () => {
    const withAtt: ItemRef = {
      ...item('1'),
      attachments: [
        { url: 'sia://fake/x', mimeType: 'image/png', byteSize: 500 },
        { url: 'sia://fake/y', mimeType: 'audio/mpeg', byteSize: 250 },
      ],
    }
    expect(channelPinByteSize(manifest({ items: [withAtt] }))).toBe(850)
  })

  it('adds avatar and cover bytes', () => {
    const m = manifest({
      items: [item('1')],
      avatar: { itemURL: 'sia://fake/av', mimeType: 'image/png', byteSize: 40 },
      cover: { itemURL: 'sia://fake/co', mimeType: 'image/png', byteSize: 60 },
    })
    expect(channelPinByteSize(m)).toBe(200)
  })

  it('treats legacy refs without byteSize as 0', () => {
    const legacyItem = { ...item('1'), byteSize: undefined as unknown as number }
    const m = manifest({
      items: [legacyItem],
      avatar: { itemURL: 'sia://fake/av', mimeType: 'image/png' }, // no byteSize
    })
    expect(channelPinByteSize(m)).toBe(0)
  })

  it('skips malformed attachments', () => {
    const withGarbage: ItemRef = {
      ...item('1'),
      attachments: [
        { url: 'sia://fake/x', mimeType: 'image/png', byteSize: 500 },
        'bare-string' as unknown as never,
        { mimeType: 'image/png' } as unknown as never,
      ],
    }
    expect(channelPinByteSize(manifest({ items: [withGarbage] }))).toBe(600)
  })
})
