// Who follows somebody, out of what the crawl has read.
//
// There is no follower list to fetch, and there could not be: a follow lives in the
// FOLLOWER's own directory, under their key, and nothing writes into the followed
// identity's scope. So the only way anyone learns they have been followed is by reading
// the person who followed them — which is exactly what the crawl does, and why this is a
// reverse scan of the index rather than a record of its own.
//
// That makes the number graph-scoped, like every other count here: it reports who follows
// them AMONG THE IDENTITIES THIS DEVICE HAS READ. It is honest, incomplete, and gets
// better on its own as the crawl widens. Two people will see different numbers for the
// same person, and that is the shape of a network with no central index rather than a
// defect in this one.
//
// Pure, and over a snapshot for the reason `directorySearch` is: reading the index costs
// one doc read per held identity, so asking the doc per render would scan the whole thing
// every time.

import type { FollowEdge } from './types'

/** What a follower scan reads out of one held record.
 *
 *  Narrow on purpose, like the search corpus: the edges and who owns them, and nothing
 *  else. */
export type FollowerEdges = {
  didDht: string
  /** Channel-follows: which channel, and whose. */
  follows: { didDht: string; channelID: string }[]
  /** People followed wholesale. */
  handleFollows: string[]
}

/** This identity's OWN follow edges, in the shape a reverse scan reads.
 *
 *  The corpus a scan runs over is the held `directory/<did>` records, and nothing ever
 *  writes one for you: the engagement crawl skips its own did before resolving, and
 *  discovery's `covered_elsewhere` excludes it. That is deliberate and right — anyone who
 *  follows one of your channels names your did as an edge target, so without the exclusion
 *  the crawl would spend a resolve and a download to be told, staler, what local state
 *  already holds.
 *
 *  It leaves the corpus short of exactly one participant, and only for the person doing
 *  the counting. Your follows ARE published — the identity loop assembles them into the
 *  directory blob everyone else crawls — so every other viewer counts you and you do not,
 *  on every channel you follow, including your own.
 *
 *  So this is the resolution ladder's own rule reaching a caller that had not applied it:
 *  your own directory is assembled from local state, and only somebody else's is resolved.
 *  Union this into the held set before scanning. */
export function ownFollowerEdges(
  didDht: string,
  follows: readonly FollowEdge[],
  handleFollows: readonly string[],
): FollowerEdges {
  return {
    didDht,
    // Narrowed to the two fields a scan reads, the same as the held records are — a
    // `FollowEdge` also carries a cached name, and carrying it here would make one
    // corpus hold two shapes.
    follows: follows.map((f) => ({ didDht: f.didDht, channelID: f.channelID })),
    handleFollows: [...handleFollows],
  }
}

/** One person this identity follows, and how.
 *
 *  THE PERSON IS THE UNIT; a channel is how somebody chooses to follow them (John,
 *  2026-09-28). So Following counts people, and following three of somebody's channels is
 *  following them once. Which of their voices you take is kept on the row, because that is
 *  where the difference is worth reading: someone who takes only your techno channel and
 *  not your cat photos is still following you. */
export type FollowedPerson = {
  didDht: string
  /** Followed wholesale: everything they advertise, now and later. */
  wholesale: boolean
  /** The channels of theirs followed one at a time. */
  channels: FollowEdge[]
}

/** The people this identity follows, by either grain, one entry each.
 *
 *  Never itself. An author follows their own public channel so that it counts toward the
 *  CHANNEL — it is what puts them among its audience — and that is authorship rather than
 *  attention: counted here it would read a profile as following somebody when it follows
 *  nobody but itself. Keyed on whoever the page is ABOUT, so it holds on somebody else's
 *  profile exactly as on your own.
 *
 *  Wholesale follows first, in the order they were made, then people followed only by
 *  channel in the order of their first edge. The mirror of {@link followersOfPerson}: A is
 *  among B's followers exactly when B is among the people A follows. */
export function followedPeople(
  didDht: string,
  follows: readonly FollowEdge[],
  handleFollows: readonly string[],
): FollowedPerson[] {
  const byDid = new Map<string, FollowedPerson>()
  const entry = (did: string) => {
    let e = byDid.get(did)
    if (!e) {
      e = { didDht: did, wholesale: false, channels: [] }
      byDid.set(did, e)
    }
    return e
  }
  for (const did of handleFollows) {
    if (did !== didDht) entry(did).wholesale = true
  }
  for (const f of follows) {
    if (f.didDht !== didDht) entry(f.didDht).channels.push(f)
  }
  return [...byDid.values()]
}

/** One person who follows somebody, and how.
 *
 *  The mirror of {@link FollowedPerson}, read from the other end: the list behind a
 *  profile's Followers number, where which of your voices somebody takes is worth reading
 *  even though it never changes the count. */
export type Follower = {
  didDht: string
  /** Follows them wholesale: everything they advertise, now and later. */
  wholesale: boolean
  /** Which of their channels this follower follows one at a time. */
  channelIDs: string[]
}

/** The people who follow this PERSON — wholesale, or through any of their channels — with
 *  how each one does.
 *
 *  The author gets the credit for all of it: somebody who follows only one of your voices
 *  is part of your audience, and a profile reading 0 while its channels have forty
 *  followers says nothing true about the person. One entry per person however many of
 *  their channels they follow, so the number moves when a person does and not when an
 *  author splits or merges channels.
 *
 *  Wholesale followers first, then by did, so the same index answers the same way twice. */
export function followersOf(
  held: readonly FollowerEdges[],
  didDht: string,
): Follower[] {
  const out = new Map<string, Follower>()
  for (const h of held) {
    // Never count somebody as their own follower. A directory can name anybody, including
    // its own author — and every author of a public channel follows it — so a self-edge
    // would inflate a number nobody could explain.
    if (h.didDht === didDht) continue
    const wholesale = h.handleFollows.includes(didDht)
    const channelIDs = h.follows
      .filter((f) => f.didDht === didDht)
      .map((f) => f.channelID)
    if (!wholesale && channelIDs.length === 0) continue
    // A held record is one per identity, but the corpus unions in the viewer's own edges,
    // so merge rather than overwrite in case one identity appears twice.
    const prev = out.get(h.didDht)
    out.set(h.didDht, {
      didDht: h.didDht,
      wholesale: wholesale || (prev?.wholesale ?? false),
      channelIDs: [...new Set([...(prev?.channelIDs ?? []), ...channelIDs])],
    })
  }
  return [...out.values()].sort(
    (a, b) =>
      Number(b.wholesale) - Number(a.wholesale) ||
      a.didDht.localeCompare(b.didDht),
  )
}

/** The did:dhts that follow this PERSON, by either grain — {@link followersOf} without the
 *  how, sorted by did. */
export function followersOfPerson(
  held: readonly FollowerEdges[],
  didDht: string,
): string[] {
  return followersOf(held, didDht)
    .map((f) => f.didDht)
    .sort()
}

/** The did:dhts a CHANNEL reaches: its own followers, plus its author's wholesale ones.
 *
 *  Following a person watches every public channel they advertise, now and later, so a
 *  wholesale follower receives this channel as surely as somebody who followed it alone.
 *  The number is the channel's audience, one per person. Pass the author when it is known;
 *  without one the count is the channel's own followers only.
 *
 *  Keyed by channelID rather than (author, channel) for the direct half: a channelID is
 *  `base32(sha256(K))`, so it already names one channel, and requiring the author would
 *  drop a follower whose record names the channel under a different author than the one
 *  asking. The author's own follow of their channel counts — it is what puts them among
 *  its audience. */
export function followersOfChannel(
  held: readonly FollowerEdges[],
  channelID: string,
  authorDidDht?: string,
): string[] {
  const out = new Set<string>()
  for (const h of held) {
    if (h.follows.some((f) => f.channelID === channelID)) out.add(h.didDht)
    else if (
      authorDidDht &&
      h.didDht !== authorDidDht &&
      h.handleFollows.includes(authorDidDht)
    ) {
      out.add(h.didDht)
    }
  }
  return [...out].sort()
}
