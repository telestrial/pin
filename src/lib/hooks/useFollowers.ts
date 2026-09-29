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
  directory_collection,
  endorse_collection,
  follow_rkey,
  person_tally_collection,
  person_tally_rkey,
  tally_collection,
} from '../../../crates/pin-core/pkg/pin_core.js'
import {
  channelFollowerCount,
  type FollowerEdges,
  followersOfChannel,
  followersOfPerson,
  ownFollowerEdges,
} from '../../core/followers'
import type { PersonTally } from '../../core/identityDoc'
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
    let running = false
    let again = false

    const count = async () => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          const held = await followerEdges(storedKeyHex)
          // Your own edges are never among the held records — see `ownFollowerEdges`.
          // Unioned here rather than inside `followerEdges`, which reads the doc and has
          // no business reaching into local state.
          const corpus = myDidDht
            ? [...held, ownFollowerEdges(myDidDht, follows, handleFollows)]
            : held
          const value = answerRef.current(corpus)
          if (!cancelled) setCounted({ subject, value })
        } while (again && !cancelled)
      } catch {
        // A crawl index that will not open is not an absence of followers.
      } finally {
        running = false
      }
    }

    // Recounted when the crawl records somebody, not only when this identity's own follows
    // move. Following a person reads them a moment AFTER the press, so a count taken at the
    // press would hold only your own edge and go on showing that. A crawl writes records in
    // bursts, so writes landing mid-count coalesce into one more count rather than one each.
    let unsub = () => {}
    void (async () => {
      try {
        await openDocs(storedKeyHex)
        await ensureWasm()
      } catch {
        return
      }
      if (cancelled) return
      const directories = directory_collection()
      unsub = subscribeDocChanges(({ collection }) => {
        if (collection === directories) void count()
      })
    })()
    void count()
    return () => {
      cancelled = true
      unsub()
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

/** A Followers number: the published follow tally for `subject` where one is held, never
 *  below `scan` — see `channelFollowerCount`.
 *
 *  Shared by a channel page and a profile, which differ only in where the tally is read:
 *  `read` answers it, and `readKey` names what `read` depends on so a change re-reads.
 *  Adjusted for this viewer's own follow of the subject by the like row's rules, from the
 *  follow record the Curator signed for it. */
function useFollowTallyCount(
  subject: string,
  read: () => Promise<PersonTally | null>,
  readKey: string,
  scan: number | null,
  warm?: () => void,
): number | null {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const myDid = useAuthStore((s) => s.myDidDht)
  const [tally, setTally] = useState<{
    key: string
    count: number
    added: boolean
    removed: boolean
  } | null>(null)
  const readRef = useRef(read)
  readRef.current = read
  const warmRef = useRef(warm)
  warmRef.current = warm
  const key = `${subject}|${readKey}`

  useEffect(() => {
    if (!storedKeyHex || !subject) return
    let cancelled = false
    let unsub = () => {}

    const refresh = async () => {
      const [aggregate, mine] = await Promise.all([
        readRef.current().catch(() => null),
        getRecord(endorse_collection(), follow_rkey(subject)).catch(
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
        key,
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
      const watched = new Set([
        tally_collection(),
        person_tally_collection(),
        endorse_collection(),
      ])
      // An unnamed event is content arriving without its key, so it re-reads rather than
      // being filtered away — the same rule the engagement row follows.
      unsub = subscribeDocChanges(({ collection }) => {
        if (collection && !watched.has(collection)) return
        void refresh()
      })
      void refresh()
      warmRef.current?.()
    })()

    return () => {
      cancelled = true
      unsub()
    }
  }, [storedKeyHex, myDid, subject, key])

  const held = tally?.key === key ? tally : null
  if (scan === null && !held) return null
  return channelFollowerCount(scan ?? 0, held)
}

/** A channel's Followers number, from the author's tally for the channel.
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
  return useFollowTallyCount(
    channelID,
    async () =>
      storedKeyHex ? readChannelTally(storedKeyHex, channelID) : null,
    `channel:${browsing}:${channelKey ?? ''}`,
    scan,
    browsing && channelKey && storedKeyHex
      ? () => void warmChannelTallies(storedKeyHex, channelID, channelKey)
      : undefined,
  )
}

/** A person's Followers number, from their person tally: this identity's own as the
 *  engagement loop folds it, or somebody else's as their directory publishes it. */
export function usePersonFollowerCount(
  didDht: string,
  published: PersonTally | null,
  scan: number | null,
): number | null {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const self = useAuthStore((s) => s.myDidDht) === didDht
  return useFollowTallyCount(
    didDht,
    async () => {
      if (!self) return published
      if (!storedKeyHex) return null
      const raw = await getRecord(
        person_tally_collection(),
        person_tally_rkey(),
      )
      return raw
        ? (JSON.parse(new TextDecoder().decode(raw)) as PersonTally)
        : null
    },
    self ? 'self' : JSON.stringify(published ?? null),
    scan,
  )
}
