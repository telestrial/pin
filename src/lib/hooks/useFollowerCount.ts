// How many identities follow a subject, out of what this device has read.
//
// A follow lives in the FOLLOWER's own directory and nothing writes into the followed
// identity's scope, so there is no follower list to fetch and there could not be: the only
// way anyone learns they have been followed is by reading whoever followed them. Which is
// what the crawl does, and why this is a reverse scan of the held index.
//
// That makes every number here graph-scoped. Two viewers see different counts for one
// subject, it is honest and incomplete, and it improves on its own as the crawl widens.

import { useEffect, useState } from 'react'
import {
  followersOfChannel,
  followersOfPerson,
  ownFollowerEdges,
} from '../../core/followers'
import { useAuthStore } from '../../stores/auth'
import { followerEdges } from '../directories'

/** Which subject is being counted: a person (their whole audience, by either grain) or a
 *  channel (its own followers plus its author's wholesale ones).
 *
 *  Scalars rather than one discriminated object, which a caller would rebuild on every
 *  render and churn the effect it feeds. */
export type FollowerGrain = 'person' | 'channel'

/** Null until counted, which the `Stat` renders as a dash.
 *
 *  Read once per landing rather than per render: the corpus is one doc read per held
 *  identity, the same shape the search box builds, so asking the doc on every render
 *  would scan the whole index every time. */
export function useFollowerCount(
  grain: FollowerGrain,
  id: string,
  /** A channel's author, whose wholesale followers it reaches. Ignored for a person. */
  authorDidDht?: string,
): number | null {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const follows = useAuthStore((s) => s.follows)
  const handleFollows = useAuthStore((s) => s.handleFollows)
  // Carries the subject it was counted FOR, which is what blanks the number when the
  // subject changes and leaves it standing when only the corpus does. Recounting because
  // your own follow moved must not flash a dash over a number about to be one higher,
  // and the dash means "not counted yet on this device" rather than "counting".
  const [counted, setCounted] = useState<{
    subject: string
    count: number
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!storedKeyHex || !id) return
    void followerEdges(storedKeyHex)
      .then((held) => {
        // Your own edges are never among the held records — see `ownFollowerEdges`.
        // Unioned here rather than inside `followerEdges`, which reads the doc and has no
        // business reaching into local state.
        const corpus = myDidDht
          ? [...held, ownFollowerEdges(myDidDht, follows, handleFollows)]
          : held
        const count =
          grain === 'person'
            ? followersOfPerson(corpus, id).length
            : followersOfChannel(corpus, id, authorDidDht).length
        if (!cancelled) setCounted({ subject: `${grain}:${id}`, count })
      })
      // A crawl index that will not open is not an absence of followers.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [storedKeyHex, grain, id, authorDidDht, myDidDht, follows, handleFollows])

  return counted?.subject === `${grain}:${id}` ? counted.count : null
}
