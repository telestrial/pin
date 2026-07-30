// Subscriber side of ladder rung 1: live-sync each subscribed channel from its
// author's node, so a new post arrives without waiting for the polling rung.
//
// Purely additive. Every channel keeps resolving through the ladder
// (useSubscriptionPull + the caching reader) exactly as before; when a sync is
// established, updates simply arrive sooner. A channel whose author publishes no
// ticket — or is offline, or unreachable — is the ordinary case, not an error.
//
// One import per channel per session. A subscribed channel isn't re-imported on a
// cadence: if the author's addresses change, this session's sync can go quiet and the
// polling rung carries the channel until the next load. That's an honest limit of
// importing a ticket once, and the reason the floor below is never removed.

import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { syncSubscribedChannelDoc } from '../channelDoc'

export function useChannelDocSync() {
  const client = useAuthStore((s) => s.client)
  // The curation kill switch (Curate page) — same gate the other background loops
  // respect: off means this instance stops working the network ahead of you.
  const curationEnabled = useAuthStore((s) => s.curationEnabled)

  useEffect(() => {
    if (!client || !curationEnabled) return
    let cancelled = false
    // Channels this session already has a sync attempt in flight or established for.
    const attempted = new Set<string>()

    const syncAll = async () => {
      const hex = useAuthStore.getState().storedKeyHex
      if (!hex) return
      const owned = new Set(
        useAuthStore.getState().myChannels.map((c) => c.channelID),
      )
      for (const sub of useAuthStore.getState().subscriptions) {
        if (cancelled) return
        // Skip your own channels: you hold their WRITE replica, so importing a read
        // ticket for the same namespace would be both pointless and conflicting.
        if (owned.has(sub.channelID)) continue
        if (attempted.has(sub.channelID)) continue
        attempted.add(sub.channelID)
        const nsId = await syncSubscribedChannelDoc(hex, sub)
        // No ticket published yet — let a later trigger retry, since the author may
        // come online during this session.
        if (!nsId) attempted.delete(sub.channelID)
      }
    }

    void syncAll()
    const unsub = useAuthStore.subscribe((s, p) => {
      if (s.subscriptions !== p.subscriptions) void syncAll()
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [client, curationEnabled])
}
