// The feed store's portal handling, which is mostly about telling two channels apart:
// the one a post was WRITTEN in and the one CIRCULATING it. Every question below has an
// answer for each, and picking the wrong one is invisible until a portal duplicates
// itself or vanishes.
//
// No network here. The resolver is an interface and these cases are about what the store
// does with its answers.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { portalKey } from '../core/feed'
import type { ChannelManifest, ItemRef, SubscriptionRef } from '../core/types'
import type { PortalOutcome, PortalResolver, PortalTarget } from '../lib/repost'
import { useFeedStore } from './feed'

const SOURCE = 'did:dht:sourceauthor'
const SRC_CHANNEL = 'srcchannel000001'
const POST_AT = '2026-05-01T09:00:00.000Z'

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

function item(publishedAt: string): ItemRef {
  return {
    id: `id-${publishedAt}`,
    itemURL: `https://sia.test/${publishedAt}`,
    type: 'text',
    title: '',
    summary: 'body',
    publishedAt,
    mimeType: 'text/markdown',
    byteSize: 32,
  }
}

function manifest(overrides: Partial<ChannelManifest> = {}): ChannelManifest {
  return {
    version: 1,
    name: 'My channel',
    description: '',
    authorPubkey: 'pubkey',
    publishedAt: '2026-05-01T00:00:00.000Z',
    items: [],
    ...overrides,
  }
}

const target: PortalTarget = {
  didDht: SOURCE,
  channelID: SRC_CHANNEL,
  publishedAt: POST_AT,
}

const aRepost = { ...target, repostedAt: '2026-06-01T09:00:00.000Z' }

/** A resolver that always answers the same way, and counts how often it was asked. */
function answering(outcome: PortalOutcome): PortalResolver & { calls: number } {
  const r = {
    calls: 0,
    resolve: async () => {
      r.calls++
      return outcome
    },
  }
  return r
}

const found: PortalOutcome = {
  state: 'resolved',
  item: item(POST_AT),
  source: {
    channelID: SRC_CHANNEL,
    channelKey: 'BBBB',
    name: 'Their channel',
    authorDidDht: SOURCE,
  },
}

describe('feed store: portals', () => {
  beforeEach(() => {
    useFeedStore.getState().reset()
  })

  /** A subscribed channel carrying one portal, already resolved. */
  async function withOnePortal(s = sub()) {
    useFeedStore.getState().applyManifest(s, manifest({ reposts: [aRepost] }))
    await useFeedStore.getState().resolvePortals(answering(found), [s])
    return s
  }

  it('shows a portal once its read comes back', async () => {
    await withOnePortal()
    const { entries } = useFeedStore.getState()
    expect(entries).toHaveLength(1)
    expect(entries[0].channel.channelID).toBe(SRC_CHANNEL)
    expect(entries[0].repost?.channel.channelID).toBe('alicechannel0001')
  })

  it('does not duplicate a portal when its channel updates', async () => {
    // The filter that decides what to replace has to ask which channel CONTRIBUTED the
    // entry. A portal carries the original's identity, so matching on that would leave
    // the old copy behind every time the circulating channel changed.
    const s = await withOnePortal()
    useFeedStore.getState().applyManifest(
      s,
      manifest({
        reposts: [aRepost],
        items: [item('2026-06-02T00:00:00.000Z')],
      }),
    )

    const { entries } = useFeedStore.getState()
    expect(entries.filter((e) => e.repost)).toHaveLength(1)
    expect(entries).toHaveLength(2)
  })

  it('drops a portal when the channel carrying it is removed', async () => {
    const s = await withOnePortal()
    useFeedStore.getState().removeChannel(s.channelID)
    expect(useFeedStore.getState().entries).toHaveLength(0)
  })

  it('keeps a portal when the channel it POINTS AT is removed', async () => {
    // Unsubscribing from the source does not take away a post somebody else is
    // circulating: that one is reached through the author's directory, not through a
    // subscription this identity just dropped.
    await withOnePortal()
    useFeedStore.getState().removeChannel(SRC_CHANNEL)
    expect(useFeedStore.getState().entries).toHaveLength(1)
  })

  it('stops asking about a post that was retracted', async () => {
    // The address includes publishedAt and a re-publish takes a new one, so nothing
    // will ever appear there again. Asking on every pass would spend three network
    // round trips forever to be told the same thing.
    const s = sub()
    useFeedStore.getState().applyManifest(s, manifest({ reposts: [aRepost] }))
    const resolver = answering({ state: 'deleted' })
    await useFeedStore.getState().resolvePortals(resolver, [s])
    await useFeedStore.getState().resolvePortals(resolver, [s])
    expect(resolver.calls).toBe(1)
  })

  it('asks again about a channel that was un-advertised', async () => {
    // Advertising is reversible, so this one can come back.
    const s = sub()
    useFeedStore.getState().applyManifest(s, manifest({ reposts: [aRepost] }))
    const resolver = answering({ state: 'unavailable' })
    await useFeedStore.getState().resolvePortals(resolver, [s])
    await useFeedStore.getState().resolvePortals(resolver, [s])
    expect(resolver.calls).toBe(2)
  })

  it('keeps showing a post when a later read cannot reach it', async () => {
    // A failed read says nothing about the post. Letting it clear one would make a slow
    // DHT look exactly like the author having retracted it.
    const s = await withOnePortal()
    await useFeedStore
      .getState()
      .resolvePortals(answering({ state: 'unreachable' }), [s])

    expect(useFeedStore.getState().entries).toHaveLength(1)
    expect(useFeedStore.getState().portals[portalKey(target)].state).toBe(
      'resolved',
    )
  })

  it('records unreachable for a portal never read at all', async () => {
    // Nothing to protect, and the owner of the channel is owed the distinction.
    const s = sub()
    useFeedStore.getState().applyManifest(s, manifest({ reposts: [aRepost] }))
    await useFeedStore
      .getState()
      .resolvePortals(answering({ state: 'unreachable' }), [s])
    expect(useFeedStore.getState().portals[portalKey(target)].state).toBe(
      'unreachable',
    )
  })

  it('reads one post once when two channels circulate it', async () => {
    const a = sub()
    const b = sub({ channelID: 'bobchannel000001', authorHandle: 'bob.test' })
    useFeedStore.getState().applyManifest(a, manifest({ reposts: [aRepost] }))
    useFeedStore
      .getState()
      .applyManifest(
        b,
        manifest({ reposts: [{ ...aRepost, repostedAt: 'z' }] }),
      )

    const resolver = answering(found)
    await useFeedStore.getState().resolvePortals(resolver, [a, b])

    expect(resolver.calls).toBe(1)
    // Both channels still show it — one read, two entries.
    expect(useFeedStore.getState().entries).toHaveLength(2)
  })

  it('asks for nothing when no channel circulates anything', async () => {
    const s = sub()
    useFeedStore
      .getState()
      .applyManifest(s, manifest({ items: [item(POST_AT)] }))
    const resolver = answering(found)
    await useFeedStore.getState().resolvePortals(resolver, [s])
    expect(resolver.calls).toBe(0)
  })

  it('clears resolved portals on reset', async () => {
    await withOnePortal()
    useFeedStore.getState().reset()
    expect(useFeedStore.getState().portals).toEqual({})
  })
})

describe('feed store: portal resolution passes a target the resolver can use', () => {
  beforeEach(() => {
    useFeedStore.getState().reset()
  })

  it('asks about the address, without the parts that are about this copy', async () => {
    const s = sub()
    useFeedStore.getState().applyManifest(s, manifest({ reposts: [aRepost] }))
    const resolve = vi.fn(async () => found)
    await useFeedStore.getState().resolvePortals({ resolve }, [s])
    expect(resolve).toHaveBeenCalledWith(target)
  })
})
