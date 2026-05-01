import { create } from 'zustand'
import { fetchChannel } from '../core/channels'
import {
  buildHomeFeed,
  type FeedEntry,
  type FeedFetchError,
} from '../core/feed'
import type { SubscriptionRef } from '../core/types'

type FeedState = {
  entries: FeedEntry[]
  errors: FeedFetchError[]
  loading: boolean
  lastRefreshedAt: string | null
  live: boolean
  refresh: (subscriptions: SubscriptionRef[]) => Promise<void>
  refreshChannel: (sub: SubscriptionRef) => Promise<void>
  setLive: (live: boolean) => void
  reset: () => void
}

export const useFeedStore = create<FeedState>()((set) => ({
  entries: [],
  errors: [],
  loading: false,
  lastRefreshedAt: null,
  live: false,
  refresh: async (subscriptions) => {
    set({ loading: true })
    const result = await buildHomeFeed(subscriptions)
    set({
      entries: result.entries,
      errors: result.errors,
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
            coverArt: manifest.coverArt,
          },
        }))
        return { entries: [...others, ...fresh] }
      })
    } catch (e) {
      console.warn(
        `Failed to refresh channel ${sub.authorHandle}/${sub.channelID}:`,
        e,
      )
    }
  },
  setLive: (live) => set({ live }),
  reset: () =>
    set({
      entries: [],
      errors: [],
      loading: false,
      lastRefreshedAt: null,
      live: false,
    }),
}))
