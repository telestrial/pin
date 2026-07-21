import { fetchChannel } from './channels'
import type {
  ChannelImage,
  ChannelManifest,
  ItemRef,
  SubscriptionRef,
} from './types'

export type FeedEntry = {
  item: ItemRef
  channel: {
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
) => Promise<ChannelManifest>

export async function buildHomeFeed(
  subscriptions: SubscriptionRef[],
  fetcher: FetchChannel = fetchChannel,
  // Last-known manifests, keyed by channelID. Stale-while-revalidate: reads go
  // through the pkarr/Mainline-DHT locator, which is eventually consistent, so a
  // momentary miss shouldn't blank a channel out of the feed. A channel that
  // fails to re-resolve but HAS a cached manifest keeps its last-known content
  // (no error); only channels with no cache at all surface as errors.
  prevManifests: Record<string, ChannelManifest> = {},
): Promise<FeedFetchResult> {
  const settled = await Promise.allSettled(
    subscriptions.map((sub) =>
      fetcher(sub.authorDID || sub.authorHandle, sub.channelID, sub.channelKey),
    ),
  )

  const entries: FeedEntry[] = []
  const errors: FeedFetchError[] = []
  const manifests: Record<string, ChannelManifest> = {}

  const pushEntries = (sub: SubscriptionRef, manifest: ChannelManifest) => {
    manifests[sub.channelID] = manifest
    for (const item of manifest.items) {
      entries.push({
        item,
        channel: {
          authorHandle: sub.authorHandle,
          authorDidDht: sub.didDht,
          channelID: sub.channelID,
          name: manifest.name,
          avatar: manifest.avatar,
        },
      })
    }
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

  entries.sort((a, b) =>
    a.item.publishedAt < b.item.publishedAt
      ? 1
      : a.item.publishedAt > b.item.publishedAt
        ? -1
        : 0,
  )

  return { entries, errors, manifests }
}
