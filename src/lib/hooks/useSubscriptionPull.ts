import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { applyCachedChannel } from '../channelRevalidate'
import { openDocs, startPullLoop, subscribeDocChanges } from '../docs'

// The frontend half of the Curator's pull loop.
//
// The loop itself is Rust now (crates/pin-curator), running in whichever engine this
// instance has — the native Curator on desktop, the wasm engine in a tab. It resolves
// each subscribed channel and writes the sealed manifest to `sub/<channelID>`. What it
// deliberately does NOT do is touch the feed: a loop that reached into the UI would
// only work while a UI existed, which is the thing that had to stop being true.
//
// So this hook does two small things. It starts the loop, and it turns a cached record
// into a feed update when one lands. That second job is why the change feed exists:
// without it, a pass would keep the cache warm and the screen would never know.
//
// The read is what fills the feed in. `applyIfChanged` no-ops when the manifest hasn't
// actually moved, so a quiet pass costs a decrypt and nothing else — no re-render, no
// churn.

const SUB_COLLECTION = 'sub'

export function useSubscriptionPull() {
  const client = useAuthStore((s) => s.client)
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)
  // The curation kill switch (Curate page). Off = this instance stops working the
  // network in the background; reads still resolve on demand, they just stop being
  // kept ahead of you.
  const curationEnabled = useAuthStore((s) => s.curationEnabled)

  useEffect(() => {
    if (!curationEnabled || !client || !appKeyHex) return
    const key = appKeyHex
    let cancelled = false

    const applyCached = (channelID: string) => {
      const sub = useAuthStore
        .getState()
        .subscriptions.find((s) => s.channelID === channelID)
      // A record for a channel we no longer subscribe to: the loop's own cleanup will
      // drop it, and we have no key to read it with anyway.
      if (!sub || cancelled) return
      void applyCachedChannel(sub)
    }

    const applyAllCached = () => {
      if (cancelled) return
      for (const sub of useAuthStore.getState().subscriptions) {
        void applyCachedChannel(sub)
      }
    }

    const unsubChanges = subscribeDocChanges(({ collection, rkey }) => {
      // NOT filtered to remote changes, unlike the settings overlay. Most `sub/`
      // writes here are LOCAL — this instance's own loop made them — and those are
      // exactly the ones the feed is waiting for. A remote one (a peer device's loop,
      // synced in) is just as welcome.
      if (collection === SUB_COLLECTION) {
        void applyCached(rkey)
        return
      }
      // A stream-level event names no record. It's the signal that content finished
      // downloading, which is precisely when an earlier read may have come up empty,
      // so re-check the set. Bounded by the subscription count.
      if (collection === '') applyAllCached()
    })

    void (async () => {
      await openDocs(key)
      if (cancelled) return
      // Whatever a previous session left cached is current enough to show immediately,
      // rather than waiting out the first pass.
      applyAllCached()
      await startPullLoop(key)
    })()

    return () => {
      cancelled = true
      unsubChanges()
    }
  }, [client, appKeyHex, curationEnabled])
}
