import { useEffect } from 'react'
import { directory_collection } from '../../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../../core/wasm'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { readChannels, useReadingStore } from '../../stores/reading'
import { openDocs, subscribeDocChanges } from '../docs'
import { computeReading } from '../reading'

// Keeps the read set current, and the feed in step with it.
//
// Recomputed when the watches or the people followed change, and when the crawl writes a
// record for somebody followed — which is how a channel a followed author adds, or takes
// off their profile, reaches the feed without anybody here doing anything.
//
// A channel that joins the set is read into the feed and one that leaves is taken out,
// which is what watching and unwatching do by hand. A channel missing only because its
// author is unsettled is NOT taken out: that absence is nobody having looked yet.

export function useReading() {
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const handleFollows = useAuthStore((s) => s.handleFollows)

  useEffect(() => {
    if (!appKeyHex) return
    let cancelled = false
    let running = false
    let again = false

    const recompute = async () => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          const next = await computeReading(
            appKeyHex,
            subscriptions,
            handleFollows,
          )
          if (cancelled) return
          // Diffed against what every reader was just given, which before the first
          // answer is the fallback — the watches alone. The feed may already have loaded
          // from that, so a first answer adding a followed person's channels has to read
          // them in like any later one.
          const prev = readChannels()
          useReadingStore.getState().setChannels(next.channels)
          const feed = useFeedStore.getState()
          const before = new Set(prev.map((c) => c.channelID))
          const after = new Set(next.channels.map((c) => c.channelID))
          for (const c of next.channels) {
            if (!before.has(c.channelID)) void feed.refreshChannel(c)
          }
          if (next.unsettled.length === 0) {
            for (const c of prev) {
              if (!after.has(c.channelID)) feed.removeChannel(c.channelID)
            }
          }
        } while (again && !cancelled)
      } catch (e) {
        // A set that will not compute leaves the last one standing, which is the
        // direction that drops nothing.
        console.warn('reading: could not compute the read set:', e)
      } finally {
        running = false
      }
    }

    let unsub: (() => void) | null = null
    void (async () => {
      await openDocs(appKeyHex)
      await ensureWasm()
      if (cancelled) return
      const directories = directory_collection()
      const followed = new Set(handleFollows)
      unsub = subscribeDocChanges(({ collection, rkey }) => {
        if (collection === directories && followed.has(rkey)) void recompute()
      })
      void recompute()
    })()

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [appKeyHex, subscriptions, handleFollows])
}
