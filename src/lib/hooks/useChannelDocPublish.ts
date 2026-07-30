// Author side of ladder rung 1: serve each owned channel as a live iroh-docs replica
// and keep a read ticket for it published, so subscribers can sync instead of polling.
//
// Off the publish critical path on purpose. `commitChannelManifest` remains the "done"
// bar for a channel write (Sia object + pkarr locator live); this mirrors the same
// manifest into the channel's doc afterwards. A failure here costs the fast rung, never
// the durable one — subscribers keep resolving the locator.
//
// "Off the critical path" is NOT "fire and forget", though. The write is retried until
// it lands, and nothing advertises a ticket for a doc whose manifest hasn't been read
// back — publishing a capability to unconfirmed content is the same mistake as
// publishing a pointer to bytes that didn't land. The fingerprint advances only on
// success, which is what makes a failure outstanding work rather than a dropped write
// (the same shape as useSettingsDocsMirror).
//
// The fingerprint is per-mount rather than persisted, deliberately: on web the channel
// replica is in-memory, so every page load starts with an empty doc that must be
// repopulated. A persisted fingerprint would skip exactly that write.
//
// Two jobs, both on the cadence as well as on change:
//   - write the current ciphertext into the doc, so a synced subscriber sees the post.
//   - RE-MINT the ticket. A ticket freezes whatever addresses were known when it was
//     made — the first one a fresh instance mints carries no relay address at all — and
//     pkarr records age off the DHT. Refreshing costs no Sia object, no manifest
//     rewrite.

import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { publishChannelDoc, refreshChannelDocTicket } from '../channelDoc'

/** How often to re-mint + republish each owned channel's ticket. Matches the instance
 *  rendezvous refresh — same problem (addresses drift, records expire), same answer. */
const TICKET_REFRESH_MS = 4 * 60 * 1000

export function useChannelDocPublish() {
  const client = useAuthStore((s) => s.client)
  // Same curation gate as the other background loops. Note what this does NOT gate:
  // publishing a channel's Sia object + locator still happens inline on write, so
  // turning curation off costs the live rung, never durability.
  const curationEnabled = useAuthStore((s) => s.curationEnabled)

  useEffect(() => {
    if (!client || !curationEnabled) return
    let cancelled = false
    // Manifest serialization last written per channel, so a quiet tick doesn't rewrite
    // an unchanged doc entry (which would churn a blob and wake every subscriber).
    const published = new Map<string, string>()

    const ownedWithManifests = () => {
      const owned = useAuthStore.getState().myChannels
      const manifests = useFeedStore.getState().manifests
      return owned.flatMap((c) => {
        const manifest = manifests[c.channelID]
        return manifest ? [{ channel: c, manifest }] : []
      })
    }

    const publishChanged = async () => {
      const hex = useAuthStore.getState().storedKeyHex
      if (!hex) return
      for (const { channel, manifest } of ownedWithManifests()) {
        if (cancelled) return
        const serialized = JSON.stringify(manifest)
        if (published.get(channel.channelID) === serialized) continue
        try {
          await publishChannelDoc(
            hex,
            channel.channelID,
            channel.channelKey,
            manifest,
          )
          published.set(channel.channelID, serialized)
        } catch (e) {
          // Leave it unrecorded so the next trigger retries.
          console.warn(
            `channel doc publish failed for ${channel.channelID}:`,
            e,
          )
        }
      }
    }

    const refreshTickets = async () => {
      const hex = useAuthStore.getState().storedKeyHex
      if (!hex) return
      for (const { channel } of ownedWithManifests()) {
        if (cancelled) return
        try {
          const advertised = await refreshChannelDocTicket(
            hex,
            channel.channelID,
            channel.channelKey,
          )
          // Doc isn't populated (a publish hasn't succeeded yet this session), so
          // nothing was advertised. Clear the fingerprint so the next tick's
          // publishChanged treats it as outstanding work.
          if (!advertised) published.delete(channel.channelID)
        } catch (e) {
          console.warn(
            `channel doc ticket refresh failed for ${channel.channelID}:`,
            e,
          )
        }
      }
    }

    // One tick does both, in order: land anything outstanding, then re-advertise what
    // is confirmed landed. Publishing needs the cadence too, not just the change
    // triggers — otherwise a failed publish would wait for the next manifest change,
    // which may never come, while the ticket timer kept running.
    const tick = async () => {
      await publishChanged()
      if (!cancelled) await refreshTickets()
    }

    void publishChanged()
    const unsubAuth = useAuthStore.subscribe((s, p) => {
      if (s.myChannels !== p.myChannels) void publishChanged()
    })
    const unsubFeed = useFeedStore.subscribe((s, p) => {
      if (s.manifests !== p.manifests) void publishChanged()
    })
    const timer = setInterval(() => void tick(), TICKET_REFRESH_MS)

    return () => {
      cancelled = true
      unsubAuth()
      unsubFeed()
      clearInterval(timer)
    }
  }, [client, curationEnabled])
}
