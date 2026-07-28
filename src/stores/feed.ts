import { create } from 'zustand'
import {
  buildHomeFeed,
  type FeedEntry,
  type FeedFetchError,
  type FetchChannel,
} from '../core/feed'
import type { ChannelManifest, SubscriptionRef } from '../core/types'

// Channels are read via the locator (pkarr → Sia). That reader needs the Sia
// sdk, so App injects it (useChannelReader) once connected. Until then reads
// can't work anyway — this default just fails loudly rather than falling back
// to atproto. Exported so useChannelReader shares the same identity: refresh
// compares against it to skip the boot-race load (see refresh below).
export const notReady: FetchChannel = () =>
  Promise.reject(new Error('channel reader not initialized'))

type FeedState = {
  entries: FeedEntry[]
  errors: FeedFetchError[]
  manifests: Record<string, ChannelManifest>
  loading: boolean
  lastRefreshedAt: string | null
  // How channels are read. Defaults to a not-ready reject; App injects the
  // locator reader (pkarr → Sia) once the sdk exists. Pluggable here (not
  // imported) to keep this store off the auth store — auth already imports
  // feed, so the reverse would be a circular import.
  channelReader: FetchChannel
  setChannelReader: (reader: FetchChannel) => void
  // `fresh` bypasses the read cache — pass it for an explicit user Refresh, leave
  // it off for background/boot loads that should take the fast path.
  refresh: (subscriptions: SubscriptionRef[], fresh?: boolean) => Promise<void>
  refreshChannel: (sub: SubscriptionRef, fresh?: boolean) => Promise<void>
  // Reflect a manifest already in hand (e.g. just committed to the locator by
  // the author) — rebuild the channel's entries + cache the manifest, no read.
  applyManifest: (sub: SubscriptionRef, manifest: ChannelManifest) => void
  setManifest: (channelID: string, manifest: ChannelManifest) => void
  removeChannel: (channelID: string) => void
  reset: () => void
}

export const useFeedStore = create<FeedState>()((set, get) => ({
  entries: [],
  errors: [],
  manifests: {},
  loading: false,
  lastRefreshedAt: null,
  channelReader: notReady,
  setChannelReader: (reader) => set({ channelReader: reader }),
  refresh: async (subscriptions, fresh = false) => {
    // Boot race: on the connect commit HomeFeed's load effect (a child effect)
    // fires before App's useChannelReader (a parent effect) injects the real
    // reader, so channelReader is still the not-ready placeholder here. Skip
    // rather than paint a "channel reader not initialized" error flash —
    // useChannelReader re-runs refresh with the real reader a beat later.
    if (get().channelReader === notReady) return
    set({ loading: true })
    // Pass the current manifests as the stale-while-revalidate fallback so a
    // channel that momentarily fails to re-resolve (DHT lag) keeps its
    // last-known content instead of dropping out of the feed.
    const result = await buildHomeFeed(
      subscriptions,
      get().channelReader,
      get().manifests,
      fresh,
    )
    set({
      entries: result.entries,
      errors: result.errors,
      manifests: result.manifests,
      lastRefreshedAt: new Date().toISOString(),
      loading: false,
    })
  },
  refreshChannel: async (sub, fresh = false) => {
    try {
      const manifest = await get().channelReader(
        sub.authorDID || sub.authorHandle,
        sub.channelID,
        sub.channelKey,
        fresh,
      )
      get().applyManifest(sub, manifest)
    } catch (e) {
      console.warn(
        `Failed to refresh channel ${sub.authorHandle}/${sub.channelID}:`,
        e,
      )
    }
  },
  applyManifest: (sub, manifest) =>
    set((s) => {
      const others = s.entries.filter(
        (e) =>
          !(
            e.channel.authorHandle === sub.authorHandle &&
            e.channel.channelID === sub.channelID
          ),
      )
      const fresh: FeedEntry[] = manifest.items.map((item) => ({
        item,
        channel: {
          authorHandle: sub.authorHandle,
          authorDidDht: sub.didDht,
          channelID: sub.channelID,
          name: manifest.name,
          avatar: manifest.avatar,
        },
      }))
      return {
        entries: [...others, ...fresh],
        manifests: { ...s.manifests, [sub.channelID]: manifest },
      }
    }),
  setManifest: (channelID, manifest) =>
    set((s) => ({
      manifests: { ...s.manifests, [channelID]: manifest },
    })),
  removeChannel: (channelID) =>
    set((s) => {
      const { [channelID]: _, ...remainingManifests } = s.manifests
      return {
        entries: s.entries.filter((e) => e.channel.channelID !== channelID),
        errors: s.errors.filter((e) => e.channelID !== channelID),
        manifests: remainingManifests,
      }
    }),
  reset: () =>
    set({
      entries: [],
      errors: [],
      manifests: {},
      loading: false,
      lastRefreshedAt: null,
    }),
}))
