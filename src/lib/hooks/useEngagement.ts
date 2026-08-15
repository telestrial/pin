// One item's engagement, as a row needs it: what everyone did, and what this identity did.
//
// Both come out of the doc, and both move without this tab doing anything — the Curator's
// loops fold and cache counts, and another of your instances may like something while
// you're looking at it. So this reads on mount and again whenever the doc says a record it
// cares about moved, which is the change feed's whole purpose.
//
// Two local reads per row rather than one pass over the feed. A row is the granularity a
// count is asked at, and `Aggregate` is shaped for exactly that — every kind for one
// subject, so rendering a row is one read rather than a scan.

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '../../stores/auth'
import { type Aggregate, readTally } from '../channelTallies'
import { getRecord, subscribeDocChanges } from '../docs'
import {
  deleteEndorsement,
  type EndorsedItem,
  collection as endorseCollection,
  endorsementRkey,
  referenceAuthorFor,
  writeEndorsement,
} from '../engagement'

/** The collections a row's counts and gestures live in. Named here only to filter the
 *  change feed; the addresses themselves come from Rust. */
const TALLY = 'tally'
const ENDORSE = 'endorse'

/** What a row shows, and what it can do. */
export type Engagement = {
  /** Counts by gesture. Zero covers both "nobody has" and "no pass has read them yet" —
   *  a row shows the same thing for each, which is nothing. */
  likes: number
  pins: number
  /** Whether THIS identity has liked it: the heart's fill. */
  liked: boolean
  toggleLike: () => void
  /** A like is in flight. The pin has its own button and its own busy state. */
  busy: boolean
}

function countOf(tally: Aggregate | null, kind: string): number {
  return tally?.kinds?.[kind]?.count ?? 0
}

export function useEngagement(item: EndorsedItem): Engagement {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const [tally, setTally] = useState<Aggregate | null>(null)
  const [liked, setLiked] = useState(false)
  const [busy, setBusy] = useState(false)

  // Destructured so the effect depends on the item's identity rather than on the object,
  // which callers rebuild every render.
  const { channelID, publishedAt, contentHash, attachment } = item

  useEffect(() => {
    if (!storedKeyHex) return
    let cancelled = false
    const target: EndorsedItem = {
      channelID,
      publishedAt,
      contentHash,
      attachment,
    }

    const refresh = async () => {
      try {
        const [counts, rkey, coll] = await Promise.all([
          readTally(storedKeyHex, target),
          endorsementRkey('like', target),
          endorseCollection(),
        ])
        const held = await getRecord(coll, rkey)
        if (cancelled) return
        setTally(counts)
        setLiked(held !== undefined)
      } catch {
        // The engine may not be open yet, or a record not downloaded. The next change
        // announces itself and this runs again; until then a row shows no counts, which
        // is what it shows for none.
      }
    }

    // A stream-level event names no collection — iroh-blobs reports content arriving
    // without saying which key it belongs to — so an unnamed one has to count as
    // "re-read" rather than be filtered away.
    const unsub = subscribeDocChanges(({ collection }) => {
      if (collection && collection !== TALLY && collection !== ENDORSE) return
      void refresh()
    })
    void refresh()

    return () => {
      cancelled = true
      unsub()
    }
  }, [storedKeyHex, channelID, publishedAt, contentHash, attachment])

  const toggleLike = useCallback(() => {
    if (!storedKeyHex || busy) return
    const target: EndorsedItem = {
      channelID,
      publishedAt,
      contentHash,
      attachment,
    }
    // Optimistic. The count this feeds is folded by a loop rather than by the click, so
    // waiting on anything before the heart moves would make the gesture read as failed.
    const next = !liked
    setLiked(next)
    setBusy(true)
    void (async () => {
      try {
        if (next) {
          await writeEndorsement(
            storedKeyHex,
            'like',
            target,
            await referenceAuthorFor(channelID),
          )
        } else {
          await deleteEndorsement(storedKeyHex, 'like', target)
        }
      } catch {
        // Put the heart back: the record didn't land, so no count will follow it.
        setLiked(!next)
      } finally {
        setBusy(false)
      }
    })()
  }, [
    storedKeyHex,
    busy,
    liked,
    channelID,
    publishedAt,
    contentHash,
    attachment,
  ])

  return {
    likes: countOf(tally, 'like'),
    pins: countOf(tally, 'pin'),
    liked,
    toggleLike,
    busy,
  }
}
