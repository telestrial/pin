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

/** The did:dhts that follow this PERSON wholesale.
 *
 *  Wholesale only. Somebody who follows one of their channels is a follower of that
 *  channel, and is counted there — the two grains are different claims, and merging them
 *  would make a profile's number unable to say which was meant. Following a person takes
 *  everything they advertise; following a channel takes one voice.
 *
 *  Sorted, so the same index answers the same way twice, and deduped — one identity
 *  naming somebody twice is still one follower. */
export function followersOfPerson(
  held: readonly FollowerEdges[],
  didDht: string,
): string[] {
  const out = new Set<string>()
  for (const h of held) {
    // Never count somebody as their own follower. A directory can name anybody, including
    // its own author, and a self-edge would inflate a number nobody could explain.
    if (h.didDht === didDht) continue
    if (h.handleFollows.includes(didDht)) out.add(h.didDht)
  }
  return [...out].sort()
}

/** The did:dhts that follow this CHANNEL.
 *
 *  Keyed by channelID alone rather than by (author, channel): a channelID is
 *  `base32(sha256(K))`, so it already names one channel and nothing else, and requiring
 *  the author would drop a follower whose record names the channel under a different
 *  author than the one asking. */
export function followersOfChannel(
  held: readonly FollowerEdges[],
  channelID: string,
): string[] {
  const out = new Set<string>()
  for (const h of held) {
    if (h.follows.some((f) => f.channelID === channelID)) out.add(h.didDht)
  }
  return [...out].sort()
}
