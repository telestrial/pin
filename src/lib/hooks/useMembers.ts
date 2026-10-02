// Who is in one of this identity's members-only channels, as the owner's panel shows it.
//
// The roster is the Curator's: a seating per invite, never deleted, a removal only ever
// marked. So the list is DERIVED from it on every read rather than kept beside it — the
// standing seatings, one per person — and a write from anywhere (this panel, another of
// the author's devices syncing in) arrives on the doc-change feed like any other.

import { useEffect, useState } from 'react'
import { members_collection } from '../../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../../core/wasm'
import { useAuthStore } from '../../stores/auth'
import { openDocs, subscribeDocChanges } from '../docs'
import { readRoster, type Seat, standingMembers } from '../members'

/** The standing members of `channelID`, or null until the roster has been read. Empty
 *  `channelID` reads nothing. */
export function useMembers(channelID: string): Seat[] | null {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const [read, setRead] = useState<{ channelID: string; seats: Seat[] } | null>(
    null,
  )

  useEffect(() => {
    if (!storedKeyHex || !channelID) return
    let cancelled = false
    let unsub: (() => void) | undefined
    const load = () =>
      readRoster(channelID)
        .then((seats) => {
          if (!cancelled) setRead({ channelID, seats: standingMembers(seats) })
        })
        // A roster that will not read leaves the last answer standing. The panel is a
        // view; the Curator is what refuses to act on a partial roster.
        .catch(() => {})
    void (async () => {
      await openDocs(storedKeyHex)
      await ensureWasm()
      if (cancelled) return
      const collection = members_collection()
      const prefix = `${channelID}:`
      unsub = subscribeDocChanges(({ collection: c, rkey }) => {
        if (c === collection && rkey.startsWith(prefix)) void load()
      })
      await load()
    })()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [storedKeyHex, channelID])

  return read?.channelID === channelID ? read.seats : null
}
