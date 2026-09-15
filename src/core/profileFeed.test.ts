import { describe, expect, it } from 'vitest'
import { feedTimeOf, portalKey, type ResolvedPortalEntry } from './feed'
import {
  buildProfileFeed,
  includedOnProfile,
  PROFILE_FEED_LIMIT,
  type ProfileChannel,
} from './profileFeed'
import type { ChannelManifest, ItemRef, RepostRef } from './types'

const AUTHOR = 'did:dht:author1'
const SOURCE = 'did:dht:source1'

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
    authorATProtoDID: '',
    publishedAt: '2026-05-01T00:00:00.000Z',
    items,
    ...overrides,
  }
}

function channel(
  channelID: string,
  items: ItemRef[],
  overrides: Partial<ProfileChannel> = {},
): ProfileChannel {
  return {
    channelID,
    manifest: manifest(channelID, items),
    ...overrides,
  }
}

describe('includedOnProfile', () => {
  it('reads an absent flag as included', () => {
    // Absent means yes, so every channel made before the flag existed keeps
    // appearing — the opposite of how `visibility` reads an absent value, and
    // right for the opposite reason.
    expect(includedOnProfile(channel('a', []))).toBe(true)
  })

  it('reads an explicit true as included', () => {
    expect(includedOnProfile(channel('a', [], { showOnProfile: true }))).toBe(
      true,
    )
  })

  it('excludes only an explicit false', () => {
    expect(includedOnProfile(channel('a', [], { showOnProfile: false }))).toBe(
      false,
    )
  })
})

describe('buildProfileFeed', () => {
  it('interleaves two channels by when each post was published', () => {
    const entries = buildProfileFeed(AUTHOR, [
      channel('one', [
        item('2026-05-01T00:00:00.000Z'),
        item('2026-05-05T00:00:00.000Z'),
      ]),
      channel('two', [
        item('2026-05-03T00:00:00.000Z'),
        item('2026-05-07T00:00:00.000Z'),
      ]),
    ])

    expect(entries.map(feedTimeOf)).toEqual([
      '2026-05-07T00:00:00.000Z',
      '2026-05-05T00:00:00.000Z',
      '2026-05-03T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    ])
  })

  it('leaves out a channel the author kept off their profile', () => {
    const entries = buildProfileFeed(AUTHOR, [
      channel('shown', [item('2026-05-01T00:00:00.000Z')]),
      channel('hidden', [item('2026-05-02T00:00:00.000Z')], {
        showOnProfile: false,
      }),
    ])

    expect(entries.map((e) => e.channel.channelID)).toEqual(['shown'])
  })

  it('presents every row under the author, whichever channel wrote it', () => {
    // A profile is one person. The channel is still named on the row, but the
    // identity underneath is the author's did — which is what a row resolves a
    // display name from.
    const entries = buildProfileFeed(AUTHOR, [
      channel('one', [item('2026-05-01T00:00:00.000Z')]),
      channel('two', [item('2026-05-02T00:00:00.000Z')]),
    ])

    expect(entries.map((e) => e.channel.authorDidDht)).toEqual([AUTHOR, AUTHOR])
    expect(entries.map((e) => e.channel.name)).toEqual(['two', 'one'])
  })

  it('caps what it returns at the newest N', () => {
    const items = Array.from({ length: PROFILE_FEED_LIMIT + 10 }, (_, i) =>
      item(`2026-05-01T00:00:${String(i).padStart(2, '0')}.000Z`),
    )
    const entries = buildProfileFeed(AUTHOR, [channel('one', items)])

    expect(entries).toHaveLength(PROFILE_FEED_LIMIT)
    // Newest kept, oldest dropped — a cap that trimmed the other end would
    // show a profile frozen at whenever its author started.
    expect(feedTimeOf(entries[0])).toBe(
      `2026-05-01T00:00:${PROFILE_FEED_LIMIT + 9}.000Z`,
    )
  })

  it('places a circulated post when it was circulated', () => {
    const target: RepostRef = {
      didDht: SOURCE,
      channelID: 'srcchannel000001',
      publishedAt: '2025-01-01T00:00:00.000Z',
      repostedAt: '2026-05-04T00:00:00.000Z',
    }
    const portals: Record<string, ResolvedPortalEntry> = {
      [portalKey(target)]: {
        item: item(target.publishedAt),
        channel: {
          authorHandle: '',
          authorDidDht: SOURCE,
          channelID: target.channelID,
          name: 'Their channel',
        },
      },
    }
    const one = channel('one', [
      item('2026-05-01T00:00:00.000Z'),
      item('2026-05-09T00:00:00.000Z'),
    ])
    one.manifest.reposts = [target]

    const entries = buildProfileFeed(AUTHOR, [one], portals)

    expect(entries.map(feedTimeOf)).toEqual([
      '2026-05-09T00:00:00.000Z',
      '2026-05-04T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    ])
  })

  it('contributes nothing for a portal nothing has resolved', () => {
    // The page has no resolution pass, so this is the state every portal is in
    // today. An unresolved portal is indistinguishable from an unreadable one,
    // and both show nothing.
    const one = channel('one', [])
    one.manifest.reposts = [
      {
        didDht: SOURCE,
        channelID: 'srcchannel000001',
        publishedAt: '2025-01-01T00:00:00.000Z',
        repostedAt: '2026-05-04T00:00:00.000Z',
      },
    ]

    expect(buildProfileFeed(AUTHOR, [one])).toHaveLength(0)
  })
})
