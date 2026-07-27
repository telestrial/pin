import { useEffect, useRef } from 'react'
import { useAuthStore } from '../../stores/auth'
import {
  cacheSubscribedChannel,
  dropSubscribedChannel,
} from '../channelLocator'

// Resolution-ladder step 2: the eager cache loop. Every LIVE instance walks its
// subscriptions, resolves each channel, and caches the ciphertext into the shared
// iroh-docs doc (`sub/<channelID>`) — on mount, on subscription add/remove, and on
// a cadence. This is what OWNS freshness: step 3 reads the doc, and this keeps the
// doc current so those reads aren't stale.
//
// It's the SAME code on web and desktop (shared TS). What varies is capability, not
// role: the desktop resolves over the direct DHT (fast) and runs even with no UI
// open (always-on), so in practice it keeps the shared doc freshest for every
// device. A web tab runs the identical loop while it's open (relay transport,
// slower) — it isn't a lesser tier, just a shorter-lived, slower-resolving instance
// of the same behavior.
//
// Pulls ALL subscriptions, including channels the user owns (owners auto-subscribe).
// That's a small redundancy with useChannelDocsMirror's `channel/<id>`; whether
// step 3 prefers the local/own copy for own channels is a step-3 decision.

const CADENCE_MS = 90_000

export function useSubscriptionPull() {
  const client = useAuthStore((s) => s.client)
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)
  // Re-run only when the SET of subscribed channels changes (add/remove) — not on
  // every cachedName/label rewrite of the subscriptions array. The cadence timer
  // handles ongoing refresh.
  const subKey = useAuthStore((s) =>
    s.subscriptions
      .map((sub) => sub.channelID)
      .sort()
      .join(','),
  )
  const knownRef = useRef<Set<string>>(new Set())

  // biome-ignore lint/correctness/useExhaustiveDependencies: subKey is a re-run trigger — its change means the subscribed-channel SET changed; the effect reads the live subscriptions via getState()
  useEffect(() => {
    if (!client || !appKeyHex) return
    const c = client
    const k = appKeyHex
    let cancelled = false

    // Drop cached records for channels no longer subscribed.
    const current = new Set(
      useAuthStore.getState().subscriptions.map((s) => s.channelID),
    )
    for (const id of knownRef.current) {
      if (!current.has(id)) void dropSubscribedChannel(k, id)
    }
    knownRef.current = current

    async function pullAll() {
      // Read fresh each pass so K/cachedName changes are picked up.
      const subs = useAuthStore.getState().subscriptions
      for (const sub of subs) {
        if (cancelled) return
        await cacheSubscribedChannel(c, k, sub.channelID, sub.channelKey)
      }
    }

    void pullAll()
    const timer = setInterval(() => void pullAll(), CADENCE_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, appKeyHex, subKey])
}
