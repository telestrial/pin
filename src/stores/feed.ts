import { create } from 'zustand'
import { fetchChannel } from '../core/channels'
import {
  buildHomeFeed,
  type FeedEntry,
  type FeedFetchError,
  type FetchChannel,
} from '../core/feed'
import type { ChannelManifest, SubscriptionRef } from '../core/types'

type FeedState = {
  entries: FeedEntry[]
  errors: FeedFetchError[]
  manifests: Record<string, ChannelManifest>
  loading: boolean
  lastRefreshedAt: string | null
  // How channels are read. Defaults to the atproto fetch; App injects the
  // locator-first reader (pkarr → Sia → atproto fallback) once the sdk exists.
  // Pluggable here (not imported) to keep this store off the auth store — auth
  // already imports feed, so the reverse would be a circular import.
  channelReader: FetchChannel
  setChannelReader: (reader: FetchChannel) => void
  refresh: (subscriptions: SubscriptionRef[]) => Promise<void>
  refreshChannel: (sub: SubscriptionRef) => Promise<void>
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
  channelReader: fetchChannel,
  setChannelReader: (reader) => set({ channelReader: reader }),
  refresh: async (subscriptions) => {
    set({ loading: true })
    const result = await buildHomeFeed(subscriptions, get().channelReader)
    set({
      entries: result.entries,
      errors: result.errors,
      manifests: result.manifests,
      lastRefreshedAt: new Date().toISOString(),
      loading: false,
    })
  },
  refreshChannel: async (sub) => {
    try {
      const manifest = await get().channelReader(
        sub.authorDID || sub.authorHandle,
        sub.channelID,
        sub.channelKey,
      )
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
      })
    } catch (e) {
      console.warn(
        `Failed to refresh channel ${sub.authorHandle}/${sub.channelID}:`,
        e,
      )
    }
  },
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
