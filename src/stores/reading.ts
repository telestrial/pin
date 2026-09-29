import { create } from 'zustand'
import type { SubscriptionRef } from '../core/types'
import { useAuthStore } from './auth'

// The channels this identity reads: its watches, plus each followed person's profile feed.
//
// Computed by the same Rust function the pull loop and the channel-doc sync run
// (`pin_curator::reading`, see lib/reading.ts), so the feed and what the Curator keeps
// cached are one answer. Kept current by `useReading`.
//
// Purely runtime. Until the first computation lands it is null, and readers fall back to
// the watches alone — which is the set exactly as it was before anybody was followed, so a
// cold boot paints what it can rather than nothing.

type ReadingState = {
  channels: SubscriptionRef[] | null
  setChannels: (channels: SubscriptionRef[]) => void
}

export const useReadingStore = create<ReadingState>()((set) => ({
  channels: null,
  setChannels: (channels) => set({ channels }),
}))

/** The channels this identity reads, as of now. */
export function readChannels(): SubscriptionRef[] {
  return (
    useReadingStore.getState().channels ?? useAuthStore.getState().subscriptions
  )
}

/** The channels this identity reads, as a render reads them. */
export function useReadChannels(): SubscriptionRef[] {
  const channels = useReadingStore((s) => s.channels)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  return channels ?? subscriptions
}
