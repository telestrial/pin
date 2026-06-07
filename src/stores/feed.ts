import { create } from 'zustand'
import { fetchChannel } from '../core/channels'
import {
  buildHomeFeed,
  type FeedEntry,
  type FeedFetchError,
} from '../core/feed'
import type { ChannelManifest, SubscriptionRef } from '../core/types'

type FeedState = {
  entries: FeedEntry[]
  errors: FeedFetchError[]
  manifests: Record<string, ChannelManifest>
  loading: boolean
  lastRefreshedAt: string | null
  live: boolean
  refresh: (subscriptions: SubscriptionRef[]) => Promise<void>
  refreshChannel: (sub: SubscriptionRef) => Promise<void>
  setManifest: (channelID: string, manifest: ChannelManifest) => void
  removeChannel: (channelID: string) => void
  setLive: (live: boolean) => void
  reset: () => void
}

export const useFeedStore = create<FeedState>()((set) => ({
  entries: [],
  errors: [],
  manifests: {},
  loading: false,
  lastRefreshedAt: null,
  live: false,
  refresh: async (subscriptions) => {
    set({ loading: true })
    const result = await buildHomeFeed(subscriptions)
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
      const manifest = await fetchChannel(
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
  setLive: (live) => set({ live }),
  reset: () =>
    set({
      entries: [],
      errors: [],
      manifests: {},
      loading: false,
      lastRefreshedAt: null,
      live: false,
    }),
}))
