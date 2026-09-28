// How many identities follow a subject, out of what this device has read.
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
  type Follower,
  type FollowerEdges,
  followersOf,
  followersOfChannel,
  followersOfPerson,
  ownFollowerEdges,
} from '../../core/followers'
import { useAuthStore } from '../../stores/auth'
import { followerEdges } from '../directories'

/** Which subject is being counted: a person (their whole audience, by either grain) or a
 *  channel (its own followers plus its author's wholesale ones). */
export type FollowerGrain = 'person' | 'channel'

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

/** How many identities follow a subject, out of what this device has read. Null until
 *  counted, which the `Stat` renders as a dash. */
export function useFollowerCount(
  grain: FollowerGrain,
  id: string,
  /** A channel's author, whose wholesale followers it reaches. Ignored for a person. */
  authorDidDht?: string,
): number | null {
  return useFollowerAnswer(
    id ? `${grain}:${id}:${authorDidDht ?? ''}` : '',
    (corpus) =>
      grain === 'person'
        ? followersOfPerson(corpus, id).length
        : followersOfChannel(corpus, id, authorDidDht).length,
  )
}

/** The people who follow a person and how, out of what this device has read — the list
 *  behind a profile's Followers number, whose length IS that number. */
export function usePersonFollowers(didDht: string): Follower[] | null {
  return useFollowerAnswer(didDht ? `followers:${didDht}` : '', (corpus) =>
    followersOf(corpus, didDht),
  )
}
