import type {
  ChannelImage,
  ChannelManifest,
  ItemRef,
  RepostRef,
  SubscriptionRef,
} from './types'

// Who a post is presented as being by. For a portal this stays the ORIGINAL's
// channel — a repost shows the post under the identity that made it, with the
// circulating channel named on a line above (see FeedEntry.repost).
export type FeedChannel = {
  authorHandle: string
  // The author's did:dht when the subscription is did:dht-native (Phase D).
  // Present → display name + directory nav resolve via the identity-doc off
  // atproto; absent → legacy atproto handle path.
  authorDidDht?: string
  channelID: string
  name: string
  // Round avatar for the feed-row identity (banner cover isn't shown here).
  avatar?: ChannelImage
}

// How a post reached the feed, when it came through somebody circulating it.
// Naming the channel AND its author because the row shows "Reposted by
// @someone" while the click-through belongs to the channel.
export type FeedRepost = {
  channel: FeedChannel
  // When it was circulated. What the entry sorts by, so a reposted post arrives
  // in the feed at the moment it was reposted rather than buried at the moment
  // it was written.
  at: string
}

export type FeedEntry = {
  item: ItemRef
  channel: FeedChannel
  repost?: FeedRepost
}

/** When an entry belongs in the feed. A portal arrives when it was circulated;
 *  everything else when it was published. */
export function feedTimeOf(entry: FeedEntry): string {
  return entry.repost?.at ?? entry.item.publishedAt
}

/** The channel whose manifest produced this entry, which for a portal is the one
 *  circulating it rather than the one that wrote it.
 *
 *  The distinction is the whole point of a portal and it is easy to get backwards.
 *  Anything asking "what did this channel contribute" — replacing a channel's entries
 *  after it changed, dropping them when it is unsubscribed — has to ask this, or a
 *  post reposted by A and written by B answers for the wrong one. */
export function contributingChannelOf(entry: FeedEntry): FeedChannel {
  return entry.repost?.channel ?? entry.channel
}

/** The address a portal names, as one string. Keys the resolution cache, so it has
 *  to be derivable from both a `RepostRef` and a resolved entry. */
export function portalKey(target: {
  didDht: string
  channelID: string
  publishedAt: string
  comment?: { actor: string; createdAt: string }
}): string {
  const post = `${target.didDht}/${target.channelID}/${target.publishedAt}`
  // A post's key is exactly what it always was — the comment part is appended only when
  // there is one — so nothing already keyed by this moves. Without the suffix a post and a
  // comment made under it would share a key, and every map keyed by this would hold one
  // where two belong: the resolved-portal cache, and the menu's idea of which of your
  // channels already carry it.
  return target.comment
    ? `${post}/${target.comment.actor}/${target.comment.createdAt}`
    : post
}

/** A resolved portal, as the collation needs it: the post, and whose it is.
 *  Deliberately structural rather than an import from lib/repost — core stays
 *  clear of the network layer, and the resolver's outcome is a superset of this. */
export type ResolvedPortalEntry = {
  item: ItemRef
  channel: FeedChannel
}

/** Every entry one channel contributes: its own items, plus the portals it
 *  circulates that have resolved.
 *
 *  Shared by the two places entries get built — a whole-feed build and a single
 *  channel being reflected after a write or a live-sync — because they were already
 *  the same rule written twice, and a portal appearing in one but not the other
 *  would show as a post vanishing whenever its channel updated.
 *
 *  A portal with no resolution yet contributes nothing. The reader's version of
 *  every failure is the same (show nothing), and an unresolved one is
 *  indistinguishable from those until it comes back. */
export function entriesForManifest(
  sub: SubscriptionRef,
  manifest: ChannelManifest,
  portals: Readonly<Record<string, ResolvedPortalEntry | undefined>> = {},
): FeedEntry[] {
  const channel: FeedChannel = {
    authorHandle: sub.authorHandle,
    authorDidDht: sub.didDht,
    channelID: sub.channelID,
    name: manifest.name,
    avatar: manifest.avatar,
  }

  const own: FeedEntry[] = manifest.items.map((item) => ({ item, channel }))

  const circulated: FeedEntry[] = []
  for (const repost of manifest.reposts ?? []) {
    const resolved = portals[portalKey(repost)]
    if (!resolved) continue
    circulated.push({
      item: resolved.item,
      // The original's identity, which is whose post this is.
      channel: resolved.channel,
      repost: { channel, at: repost.repostedAt },
    })
  }

  return [...own, ...circulated]
}

/** The portals a set of manifests names, deduplicated. What a resolution pass has
 *  to work through, and the dedup matters because two channels circulating one post
 *  is one thing to read. */
export function portalsIn(
  manifests: Readonly<Record<string, ChannelManifest>>,
): RepostRef[] {
  const seen = new Map<string, RepostRef>()
  for (const manifest of Object.values(manifests)) {
    for (const repost of manifest.reposts ?? []) {
      const key = portalKey(repost)
      if (!seen.has(key)) seen.set(key, repost)
    }
  }
  return [...seen.values()]
}

export type FeedFetchError = {
  authorHandle: string
  channelID: string
  label?: string
  error: string
}

export type FeedFetchResult = {
  entries: FeedEntry[]
  errors: FeedFetchError[]
  manifests: Record<string, ChannelManifest>
}

export type FetchChannel = (
  authorHandleOrDID: string,
  channelID: string,
  channelKey: string,
  // Skip any local cache and go to the network. Set when the READ IS THE POINT —
  // an explicit user Refresh — so the one control a reader has can't be answered
  // from a cache that a background pass hasn't caught up on yet. Ordinary reads
  // leave it off and take the fast path.
  fresh?: boolean,
) => Promise<ChannelManifest>

export async function buildHomeFeed(
  subscriptions: SubscriptionRef[],
  // Reads go through the locator (pkarr → Sia); the caller injects it. No
  // default reader — channels can't be read without the Sia sdk.
  fetcher: FetchChannel,
  // Last-known manifests, keyed by channelID. Stale-while-revalidate: reads go
  // through the pkarr/Mainline-DHT locator, which is eventually consistent, so a
  // momentary miss shouldn't blank a channel out of the feed. A channel that
  // fails to re-resolve but HAS a cached manifest keeps its last-known content
  // (no error); only channels with no cache at all surface as errors.
  prevManifests: Record<string, ChannelManifest> = {},
  // Forwarded to the fetcher — see FetchChannel.fresh.
  fresh = false,
  // Portals already resolved, keyed by `portalKey`. Passed in rather than resolved
  // here because resolving one is a walk of somebody ELSE's floor rung — three DHT
  // resolves and three Sia reads — and holding the feed build on that would keep
  // every post off the screen until the slowest stranger answered. The resolution
  // pass fills this in and the collation runs again.
  portals: Readonly<Record<string, ResolvedPortalEntry | undefined>> = {},
): Promise<FeedFetchResult> {
  const settled = await Promise.allSettled(
    subscriptions.map((sub) =>
      fetcher(
        sub.authorDID || sub.authorHandle,
        sub.channelID,
        sub.channelKey,
        fresh,
      ),
    ),
  )

  const entries: FeedEntry[] = []
  const errors: FeedFetchError[] = []
  const manifests: Record<string, ChannelManifest> = {}

  const pushEntries = (sub: SubscriptionRef, manifest: ChannelManifest) => {
    manifests[sub.channelID] = manifest
    entries.push(...entriesForManifest(sub, manifest, portals))
  }

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    const sub = subscriptions[i]
    if (result.status === 'fulfilled') {
      pushEntries(sub, result.value)
    } else {
      const cached = prevManifests[sub.channelID]
      if (cached) {
        // Keep last-known content — the DHT will catch up on a later refresh.
        pushEntries(sub, cached)
      } else {
        errors.push({
          authorHandle: sub.authorHandle,
          channelID: sub.channelID,
          label: sub.label,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        })
      }
    }
  }

  entries.sort((a, b) => {
    const at = feedTimeOf(a)
    const bt = feedTimeOf(b)
    return at < bt ? 1 : at > bt ? -1 : 0
  })

  return { entries, errors, manifests }
}
