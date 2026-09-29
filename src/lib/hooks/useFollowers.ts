// Who follows a subject and how, out of what this device has read — the lists behind
// the Followers numbers, whose lengths ARE those numbers.
//
// A follow lives in the FOLLOWER's own directory and nothing writes into the followed
// identity's scope, so there is no follower list to fetch and there could not be: the only
// way anyone learns they have been followed is by reading whoever followed them. Which is
// what the crawl does, and why this is a reverse scan of the held index.
//
// That makes every number here graph-scoped. Two viewers see different counts for one
// subject, it is honest and incomplete, and it improves on its own as the crawl widens.

import { useEffect, useRef, useState } from 'react'
import {
  endorse_collection,
  follow_rkey,
  tally_collection,
} from '../../../crates/pin-core/pkg/pin_core.js'
import {
  channelFollowerCount,
  type FollowerEdges,
  followersOfChannel,
  followersOfPerson,
  ownFollowerEdges,
} from '../../core/followers'
import { ensureWasm } from '../../core/wasm'
import { useAuthStore } from '../../stores/auth'
import { readChannelTally, warmChannelTallies } from '../channelTallies'
import { followerEdges } from '../directories'
import { getRecord, openDocs, subscribeDocChanges } from '../docs'
import { showsUncounted, showsWithdrawn } from './useEngagement'

/** One answer computed over the follower corpus — the held index plus your own edges —
 *  or null until it has been.
 *
 *  Read once per landing rather than per render: the corpus is one doc read per held
 *  identity, the same shape the search box builds, so asking the doc on every render
 *  would scan the whole index every time. `subject` names what the answer is FOR, which
 *  is what blanks it when the subject changes and leaves it standing when only the corpus
 *  does: recounting because your own follow moved must not flash a dash over a number
 *  about to be one higher. The dash means "not counted yet on this device". */
function useFollowerAnswer<T>(
  subject: string,
  answer: (corpus: FollowerEdges[]) => T,
): T | null {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const follows = useAuthStore((s) => s.follows)
  const handleFollows = useAuthStore((s) => s.handleFollows)
  const [counted, setCounted] = useState<{ subject: string; value: T } | null>(
    null,
  )
  // The computation, kept current without making every caller memoize it: `subject`
  // already names everything it depends on.
  const answerRef = useRef(answer)
  answerRef.current = answer

  useEffect(() => {
    let cancelled = false
    if (!storedKeyHex || !subject) return
    void followerEdges(storedKeyHex)
      .then((held) => {
        // Your own edges are never among the held records — see `ownFollowerEdges`.
        // Unioned here rather than inside `followerEdges`, which reads the doc and has no
        // business reaching into local state.
        const corpus = myDidDht
          ? [...held, ownFollowerEdges(myDidDht, follows, handleFollows)]
          : held
        const value = answerRef.current(corpus)
        if (!cancelled) setCounted({ subject, value })
      })
      // A crawl index that will not open is not an absence of followers.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [storedKeyHex, subject, myDidDht, follows, handleFollows])

  return counted?.subject === subject ? counted.value : null
}

/** The people who follow a person, out of what this device has read — the list behind a
 *  profile's Followers number, whose length IS that number. */
export function usePersonFollowers(didDht: string): string[] | null {
  return useFollowerAnswer(didDht ? `person:${didDht}` : '', (corpus) =>
    followersOfPerson(corpus, didDht),
  )
}

/** The people who follow a channel — the list behind a channel's Followers number, whose
 *  length IS that number. */
export function useChannelFollowers(channelID: string): string[] | null {
  return useFollowerAnswer(channelID ? `channel:${channelID}` : '', (corpus) =>
    followersOfChannel(corpus, channelID),
  )
}

/** A channel's Followers number: the author's published tally where one is held, never
 *  below `scan` — see `channelFollowerCount`.
 *
 *  Warms the tally when only browsing, because no loop keeps counts for a channel this
 *  identity neither owns nor reads; for one it does, the loops already land them here. */
export function useChannelFollowerCount(
  channelID: string,
  channelKey: string | undefined,
  browsing: boolean,
  scan: number | null,
): number | null {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const myDid = useAuthStore((s) => s.myDidDht)
  const [tally, setTally] = useState<{
    channelID: string
    count: number
    added: boolean
    removed: boolean
  } | null>(null)

  useEffect(() => {
    if (!storedKeyHex || !channelID) return
    let cancelled = false
    let unsub = () => {}

    const refresh = async () => {
      const [aggregate, mine] = await Promise.all([
        readChannelTally(storedKeyHex, channelID),
        getRecord(endorse_collection(), follow_rkey(channelID)).catch(
          () => undefined,
        ),
      ])
      if (cancelled) return
      if (!aggregate) {
        setTally(null)
        return
      }
      let heldAt: string | null = null
      try {
        if (mine)
          heldAt = JSON.parse(new TextDecoder().decode(mine)).createdAt ?? null
      } catch {
        // An unreadable record of our own is no record, which adjusts nothing.
      }
      const follow = aggregate.kinds?.follow
      setTally({
        channelID,
        count: follow?.count ?? 0,
        added: showsUncounted(heldAt, aggregate.updatedAt),
        removed: showsWithdrawn(myDid, heldAt, follow?.sampleActors),
      })
    }

    void (async () => {
      try {
        await openDocs(storedKeyHex)
        await ensureWasm()
      } catch {
        return
      }
      if (cancelled) return
      const tallies = tally_collection()
      const endorsements = endorse_collection()
      // An unnamed event is content arriving without its key, so it re-reads rather than
      // being filtered away — the same rule the engagement row follows.
      unsub = subscribeDocChanges(({ collection }) => {
        if (collection && collection !== tallies && collection !== endorsements)
          return
        void refresh()
      })
      void refresh()
      if (browsing && channelKey) {
        void warmChannelTallies(storedKeyHex, channelID, channelKey)
      }
    })()

    return () => {
      cancelled = true
      unsub()
    }
  }, [storedKeyHex, myDid, channelID, channelKey, browsing])

  const held = tally?.channelID === channelID ? tally : null
  if (scan === null && !held) return null
  return channelFollowerCount(scan ?? 0, held)
}
