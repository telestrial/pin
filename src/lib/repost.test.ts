import { describe, expect, it } from 'vitest'
import type { FeedEntry } from '../core/feed'
import type { ChannelManifest, ItemRef } from '../core/types'
import {
  channelOfSource,
  isPermanent,
  repostTargetFor,
  targetOf,
} from './repost'

const SOURCE = 'did:dht:sourceauthor'
const POST_AT = '2026-05-01T09:00:00.000Z'

function item(): ItemRef {
  return {
    id: 'obj1',
    itemURL: 'sia://obj1',
    type: 'text',
    title: '',
    summary: 'a post',
    publishedAt: POST_AT,
    mimeType: 'text/markdown',
    byteSize: 6,
  }
}

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    item: item(),
    channel: {
      authorHandle: '',
      authorDidDht: SOURCE,
      channelID: 'srcchannel000001',
      name: 'Their channel',
    },
    ...overrides,
  }
}

function manifest(
  visibility: ChannelManifest['visibility'],
): Record<string, ChannelManifest> {
  return {
    srcchannel000001: {
      version: 1,
      name: 'Their channel',
      description: '',
      authorPubkey: 'pubkey',
      publishedAt: POST_AT,
      visibility,
      items: [],
    },
  }
}

describe('repostTargetFor', () => {
  it('names the address of a post in a public channel', () => {
    expect(repostTargetFor(entry(), manifest('public'))).toEqual({
      didDht: SOURCE,
      channelID: 'srcchannel000001',
      publishedAt: POST_AT,
    })
  })

  it('refuses a post in an unlisted channel', () => {
    // Circulating it would publish the channel's existence to the reposter's
    // subscribers, which is the one property that tier has — and the portal could not
    // resolve anyway, since its key comes from a directory an unlisted channel is
    // deliberately absent from.
    expect(repostTargetFor(entry(), manifest('obscure'))).toBeNull()
  })

  it('refuses a channel whose visibility is unknown', () => {
    // Being unable to tell is not a reason to treat it as public.
    expect(repostTargetFor(entry(), {})).toBeNull()
  })

  it('refuses a post whose author has no did:dht', () => {
    // A portal is (didDht, channelID, publishedAt); there is nothing to point at.
    const legacy = entry({
      channel: {
        authorHandle: 'alice.test',
        channelID: 'srcchannel000001',
        name: 'Their channel',
      },
    })
    expect(repostTargetFor(legacy, manifest('public'))).toBeNull()
  })

  it('allows a post already reaching the feed through a portal', () => {
    // It was read out of an author's directory, and only public channels are
    // advertised there — so it is public by construction, with no manifest needed.
    const circulated = entry({
      repost: {
        channel: {
          authorHandle: '',
          authorDidDht: 'did:dht:someoneelse',
          channelID: 'theirchannel0001',
          name: 'Someone else',
        },
        at: '2026-06-01T00:00:00.000Z',
      },
    })
    expect(repostTargetFor(circulated, {})).not.toBeNull()
  })

  it('points a reposted repost at the original', () => {
    // The collapse rule, and it needs no code: an entry's `channel` is whose post it
    // is, never who passed it along, so an address can never accumulate a chain.
    const circulated = entry({
      repost: {
        channel: {
          authorHandle: '',
          authorDidDht: 'did:dht:someoneelse',
          channelID: 'theirchannel0001',
          name: 'Someone else',
        },
        at: '2026-06-01T00:00:00.000Z',
      },
    })
    expect(repostTargetFor(circulated, {})).toEqual({
      didDht: SOURCE,
      channelID: 'srcchannel000001',
      publishedAt: POST_AT,
    })
  })
})

describe('targetOf', () => {
  it('drops the parts that are about this copy rather than the post', () => {
    expect(
      targetOf({
        didDht: SOURCE,
        channelID: 'srcchannel000001',
        publishedAt: POST_AT,
        repostedAt: '2026-06-01T00:00:00.000Z',
        cachedName: 'Their channel',
      }),
    ).toEqual({
      didDht: SOURCE,
      channelID: 'srcchannel000001',
      publishedAt: POST_AT,
    })
  })
})

describe('isPermanent', () => {
  it('treats only a retract as final', () => {
    // An un-advertised channel can be advertised again and an unreachable one is the
    // network rather than an answer. Only a retract can never come back, because a
    // re-publish takes a new publishedAt and so a new address.
    expect(isPermanent({ state: 'deleted' })).toBe(true)
    expect(isPermanent({ state: 'unavailable' })).toBe(false)
    expect(isPermanent({ state: 'unreachable' })).toBe(false)
  })
})

describe('channelOfSource', () => {
  it('presents a source as a did:dht identity with no handle', () => {
    // A source is reached through its author's directory, which has no atproto handle
    // in it — the same shape a did:dht subscription already carries, so a portal row
    // and a subscribed row render through one path.
    expect(
      channelOfSource({
        channelID: 'srcchannel000001',
        channelKey: 'BBBB',
        name: 'Their channel',
        authorDidDht: SOURCE,
      }),
    ).toEqual({
      authorHandle: '',
      authorDidDht: SOURCE,
      channelID: 'srcchannel000001',
      name: 'Their channel',
      avatar: undefined,
    })
  })
})
