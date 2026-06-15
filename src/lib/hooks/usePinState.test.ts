import { describe, expect, it } from 'vitest'
import type { ItemRef } from '../../core/types'
import type { PinnedItemRef } from '../../stores/pin'
import { computePinState } from './usePinState'

const PUBLISHED_AT = '2026-05-15T10:00:00.000Z'
const CHANNEL = 'abc123channelid0'
const OTHER_CHANNEL = 'def456channelid0'

function makeItem(overrides: Partial<ItemRef> = {}): ItemRef {
  return {
    id: 'item-current',
    itemURL: 'https://sia.test/current',
    type: 'text',
    title: '',
    summary: 'current body',
    publishedAt: PUBLISHED_AT,
    mimeType: 'text/markdown',
    byteSize: 64,
    contentHash: 'cid-current',
    ...overrides,
  }
}

function makePin(overrides: Partial<PinnedItemRef> = {}): PinnedItemRef {
  return {
    item: makeItem({ id: 'item-pinned', contentHash: 'cid-pinned' }),
    channel: {
      authorHandle: 'alice.test',
      channelID: CHANNEL,
      name: 'Alice',
    },
    objectID: 'obj-pinned',
    pinnedAt: '2026-05-15T11:00:00.000Z',
    ...overrides,
  }
}

describe('computePinState', () => {
  it("returns 'pinned' for an item in a channel you own (no drift on your own posts)", () => {
    const state = computePinState(
      makeItem(),
      CHANNEL,
      [{ channelID: CHANNEL }],
      [],
    )
    expect(state).toBe('pinned')
  })

  it("returns 'pinnable' when the item is not pinned by the reader", () => {
    const state = computePinState(makeItem(), CHANNEL, [], [])
    expect(state).toBe('pinnable')
  })

  it("returns 'pinned' when the pin's contentHash matches the current item", () => {
    const item = makeItem({ contentHash: 'cid-same' })
    const pin = makePin({
      item: makeItem({ contentHash: 'cid-same' }),
    })
    expect(computePinState(item, CHANNEL, [], [pin])).toBe('pinned')
  })

  it("returns 'edited' when the pin's contentHash differs from the current item", () => {
    const item = makeItem({ contentHash: 'cid-new' })
    const pin = makePin({
      item: makeItem({ contentHash: 'cid-old' }),
    })
    expect(computePinState(item, CHANNEL, [], [pin])).toBe('edited')
  })

  it("matches a pin by (channelID, publishedAt) — different publishedAt is treated as 'pinnable'", () => {
    const item = makeItem({ publishedAt: '2026-05-15T10:00:00.000Z' })
    const pin = makePin({
      item: makeItem({ publishedAt: '2026-05-15T09:00:00.000Z' }),
    })
    expect(computePinState(item, CHANNEL, [], [pin])).toBe('pinnable')
  })

  it("a pin on a different channel does not match (same publishedAt, different channelID)", () => {
    const pin = makePin({
      channel: { authorHandle: 'bob.test', channelID: OTHER_CHANNEL, name: 'Bob' },
    })
    expect(computePinState(makeItem(), CHANNEL, [], [pin])).toBe('pinnable')
  })

  it("legacy: pin without contentHash falls through to 'pinned' (can't detect drift)", () => {
    const item = makeItem({ contentHash: 'cid-current' })
    const pin = makePin({
      item: makeItem({ contentHash: undefined }),
    })
    expect(computePinState(item, CHANNEL, [], [pin])).toBe('pinned')
  })

  it("legacy: item without contentHash falls through to 'pinned' (can't detect drift)", () => {
    const item = makeItem({ contentHash: undefined })
    const pin = makePin({
      item: makeItem({ contentHash: 'cid-pinned' }),
    })
    expect(computePinState(item, CHANNEL, [], [pin])).toBe('pinned')
  })

  it("ownership shortcut wins over a pin record with drift on the same channel", () => {
    // If somehow an owned channel also appears in pinned[] with different
    // contentHash, ownership wins and we still get 'pinned' (not 'edited').
    const item = makeItem({ contentHash: 'cid-new' })
    const pin = makePin({
      item: makeItem({ contentHash: 'cid-old' }),
    })
    expect(
      computePinState(item, CHANNEL, [{ channelID: CHANNEL }], [pin]),
    ).toBe('pinned')
  })
})
