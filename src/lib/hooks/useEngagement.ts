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
   *  their fold provably predates it (see {@link showsUncounted}), less one it can be
   *  shown to still include after we took it back (see {@link showsWithdrawn}). Zero
   *  covers both "nobody has" and "no pass has read them yet" — a row shows the same
   *  thing for each, which is nothing.
   *
   *  The two adjustments are mutually exclusive by construction: one needs a record held,
   *  the other needs none. Neither ever overstates the count. */
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

/** Whether the published count still includes a gesture this identity has taken back.
 *
 *  The mirror of {@link showsUncounted}, and deliberately the weaker claim of the two.
 *  Subtracting is only honest with evidence the author's fold actually counted us, and the
 *  one piece of that evidence a row holds locally is `sampleActors`: it is drawn from the
 *  same fold as the count, so our own DID appearing there means that count includes us.
 *  No record held any more, and named in the sample, is a count that is one high.
 *
 *  Partial by construction — the sample is five actors — so above that we cannot tell
 *  whether we were counted, nothing is subtracted, and the row shows what it showed
 *  before: one high until the author folds again. Sound in both directions, which is the
 *  point: it never subtracts from a count that didn't include us, and that failure would
 *  show a row LOWER than the truth over a gesture somebody else made.
 *
 *  The complete alternative — remembering the withdrawal locally and subtracting until a
 *  newer fold arrives — was not taken. It cannot tell a gesture the author counted from
 *  one whose knock never reached them, so it would read a count too low exactly when
 *  delivery had failed. A definitive membership test needs an inclusion proof against
 *  `setRoot`, which is the `audit` verb, and not something a row can do locally. */
export function showsWithdrawn(
  myDid: string | null,
  heldAt: string | null,
  sampleActors: string[] | undefined,
): boolean {
  if (heldAt !== null) return false
  // Narrows the type rather than deciding anything: a sample of actor DIDs could not name
  // an absent one either way. It resolves a moment after boot.
  if (!myDid) return false
  return (sampleActors ?? []).includes(myDid)
}

/** What a row shows: the author's count, adjusted by the two things we can prove about it.
 *
 *  Floored because the count is another party's data — one naming us in its sample while
 *  claiming zero must not render as -1. */
function shown(base: number, added: boolean, removed: boolean): number {
  return Math.max(0, base + (added ? 1 : 0) - (removed ? 1 : 0))
}

function sampleOf(tally: Aggregate | null, kind: string): string[] | undefined {
  return tally?.kinds?.[kind]?.sampleActors
}

export function useEngagement(item: EndorsedItem): Engagement {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  // Read rather than derived: whether a published count counts us is a question about our
  // own DID, and the sample answers it by naming actors.
  const myDid = useAuthStore((s) => s.myDidDht)
  const [tally, setTally] = useState<Aggregate | null>(null)
  const [liked, setLiked] = useState(false)
  const [busy, setBusy] = useState(false)
  // Gestures this identity has made that the published count can't have seen yet, so a
  // row can show its own contribution while the author's fold catches up.
  const [mine, setMine] = useState({ like: false, pin: false })
  // Gestures taken back that the published count can be shown to still include, so a row
  // can drop its own contribution while the author's fold catches up.
  const [withdrawn, setWithdrawn] = useState({ like: false, pin: false })

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
        setWithdrawn({
          like: showsWithdrawn(myDid, likedAt, sampleOf(counts, 'like')),
          pin: showsWithdrawn(myDid, pinnedAt, sampleOf(counts, 'pin')),
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
  }, [storedKeyHex, myDid, channelID, publishedAt, contentHash, attachment])

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
    // The subtraction is deliberately NOT optimistic. Deleting the record is a local doc
    // write, so the change feed announces it and `refresh` re-reads within a tick — and
    // the heart has already emptied, so the gesture doesn't read as failed in the way an
    // unmoved count would. One less piece of state that can disagree with the doc.
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
    likes: shown(countOf(tally, 'like'), mine.like, withdrawn.like),
    pins: shown(countOf(tally, 'pin'), mine.pin, withdrawn.pin),
    liked,
    toggleLike,
    busy,
  }
}
