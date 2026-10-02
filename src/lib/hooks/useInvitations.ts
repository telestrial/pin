// Invitations to members-only channels that are still waiting on an answer.
//
// The Curator writes a membership when an invitation addressed to this identity opens —
// from a knock or from a directory the crawl read — and climbs to the channel's key on its
// next pull. What makes one PENDING is decided here, from local state: not a channel
// already watched, not one this identity owns, not one turned down. Accepting is a watch
// and dismissing is a settings entry, so both leave the membership standing, which is the
// Curator's record and not the screen's to delete.

import { useEffect, useState } from 'react'
import { membership_collection } from '../../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../../core/wasm'
import { useAuthStore } from '../../stores/auth'
import { openDocs, subscribeDocChanges } from '../docs'
import { type Membership, readMemberships } from '../members'

export type Invitation = { channelID: string; membership: Membership }

/** Every invitation still to be accepted or dismissed. Empty until read. */
export function useInvitations(): Invitation[] {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const myChannels = useAuthStore((s) => s.myChannels)
  const dismissed = useAuthStore((s) => s.dismissedInvitations)
  const [held, setHeld] = useState<Invitation[]>([])

  useEffect(() => {
    if (!storedKeyHex) return
    let cancelled = false
    let unsub: (() => void) | undefined
    const load = () =>
      readMemberships()
        .then((all) => {
          if (!cancelled) setHeld(all)
        })
        .catch(() => {})
    void (async () => {
      await openDocs(storedKeyHex)
      await ensureWasm()
      if (cancelled) return
      const collection = membership_collection()
      unsub = subscribeDocChanges(({ collection: c }) => {
        if (c === collection) void load()
      })
      await load()
    })()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [storedKeyHex])

  const answered = new Set([
    ...subscriptions.map((s) => s.channelID),
    ...myChannels.map((c) => c.channelID),
    ...dismissed,
  ])
  return held.filter((i) => !answered.has(i.channelID))
}
