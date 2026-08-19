// One item's engagement, as a row needs it: what everyone did, and what this identity did.
//
// Both come out of the doc, and both move without this tab doing anything — the Curator's
// loops fold and cache counts, and another of your instances may like something while
// you're looking at it. So this reads on mount and again whenever the doc says a record it
// cares about moved, which is the change feed's whole purpose.
//
// The two are also combined here rather than shown side by side. A count is the AUTHOR's,
// folded over what had reached them, so a gesture you just made isn't in it and won't be
// until they fold again — which on your own screen reads as a click that changed nothing.
// A record stamped after their fold is one that fold demonstrably didn't see, so it can be
// added without ever double-counting. See `showsUncounted`.
//
// Two local reads per row rather than one pass over the feed. A row is the granularity a
// count is asked at, and `Aggregate` is shaped for exactly that — every kind for one
// subject, so rendering a row is one read rather than a scan.

import { useCallback, useEffect, useState } from 'react'
import { useAuthStore } from '../../stores/auth'
import { type Aggregate, readTally } from '../channelTallies'
import { openDocs, subscribeDocChanges } from '../docs'
import {
  deleteEndorsement,
  type EndorsedItem,
  heldEndorsedAt,
  referenceAuthorFor,
  writeEndorsement,
} from '../engagement'

/** The collections a row's counts and gestures live in. Named here only to filter the
 *  change feed; the addresses themselves come from Rust. */
const TALLY = 'tally'
const ENDORSE = 'endorse'

/** What a row shows, and what it can do. */
export type Engagement = {
  /** Counts by gesture: what the author published, plus this identity's own gesture when
   *  their fold provably predates it (see {@link showsUncounted}). Zero covers both
   *  "nobody has" and "no pass has read them yet" — a row shows the same thing for each,
   *  which is nothing.
   *
   *  Not symmetric on withdrawal: taking back a gesture the author HAD already folded
   *  leaves the count one high until they fold again, because nothing we hold says
   *  whether their set included us. Unchanged from before this adjustment existed. */
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

/** Whether this identity's own endorsement is one the published count cannot include.
 *
 *  The count a row shows is the author's, folded over what had reached them when they
 *  folded it. So your own gesture doesn't move it until they fold again, and on your own
 *  screen that reads as a click that did nothing.
 *
 *  A fold stamped at T can only contain records written before T, so a record stamped
 *  after it is one that fold provably didn't see. Adding it is correct by construction
 *  rather than optimistic: it cannot double-count, it stops counting itself the moment a
 *  fold that includes it arrives, and the +1 is backed by a record you hold and could be
 *  asked to produce.
 *
 *  No tally at all means nothing has counted it, so a record you hold is uncounted.
 *
 *  This compares your clock against the author's, which is the one soft spot — a skew
 *  either way is worth a +1 shown or withheld for the length of it, on your own screen,
 *  for a gesture you just made. */
export function showsUncounted(
  heldAt: string | null,
  talliedAt: string | undefined,
): boolean {
  if (heldAt === null) return false
  if (!talliedAt) return true
  return heldAt > talliedAt
}

export function useEngagement(item: EndorsedItem): Engagement {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const [tally, setTally] = useState<Aggregate | null>(null)
  const [liked, setLiked] = useState(false)
  const [busy, setBusy] = useState(false)
  // Gestures this identity has made that the published count can't have seen yet, so a
  // row can show its own contribution while the author's fold catches up.
  const [mine, setMine] = useState({ like: false, pin: false })

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
        const [counts, likedAt, pinnedAt] = await Promise.all([
          readTally(storedKeyHex, target),
          heldEndorsedAt('like', target),
          heldEndorsedAt('pin', target),
        ])
        if (cancelled) return
        setTally(counts)
        setLiked(likedAt !== null)
        setMine({
          like: showsUncounted(likedAt, counts?.updatedAt),
          pin: showsUncounted(pinnedAt, counts?.updatedAt),
        })
      } catch {
        // The engine may not be open yet, or a record not downloaded. The next change
        // announces itself and this runs again; until then a row shows no counts, which
        // is what it shows for none.
      }
    }

    // Attached only once the doc is open, and BEFORE the first read.
    //
    // Both halves of that order are load-bearing. Subscribing to an engine that isn't up
    // yet fails — on desktop the doc belongs to the Curator, which the app waits for —
    // and the failure is silent, so the row would keep whatever it read on mount for the
    // life of the session. Reading before subscribing would drop a change that landed in
    // between, which for a count folded by a background loop is most of them.
    let unsub = () => {}
    void (async () => {
      try {
        await openDocs(storedKeyHex)
      } catch {
        // Nothing to watch and nothing to read; the next mount tries again.
        return
      }
      if (cancelled) return
      // A stream-level event names no collection — iroh-blobs reports content arriving
      // without saying which key it belongs to — so an unnamed one has to count as
      // "re-read" rather than be filtered away.
      unsub = subscribeDocChanges(({ collection }) => {
        if (collection && collection !== TALLY && collection !== ENDORSE) return
        void refresh()
      })
      void refresh()
    })()

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
    // A record written now is stamped now, so it is certainly newer than any tally that
    // exists — and having withdrawn one, there is nothing of ours left to add.
    setMine((m) => ({ ...m, like: next }))
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
        setMine((m) => ({ ...m, like: !next }))
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
    likes: countOf(tally, 'like') + (mine.like ? 1 : 0),
    pins: countOf(tally, 'pin') + (mine.pin ? 1 : 0),
    liked,
    toggleLike,
    busy,
  }
}
