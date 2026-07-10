import { listFollows as defaultListFollows, parseChannelAtURI } from './follow'

export type NetworkReach = {
  // R0: people whose channels you directly hold (subscription authors).
  direct: number
  // R1 only: authors your follows follow that you don't already hold.
  extended: number
  // Distinct identities reachable one hop out (R0 ∪ R1), excluding yourself.
  total: number
}

// A public-follow-list fetcher, injectable for tests. Structurally a subset of
// `listFollows` (we only read each record's subject), so the real one drops in.
export type FollowsFetcher = (
  handleOrDID: string,
) => Promise<Array<{ record: { subject: string } }>>

// Count the distinct identities (DIDs) reachable through your network, one hop
// out. R0 = people whose channels you hold; R1 = the authors of channels those
// people publicly follow. This is the candidate pool a mention picker draws from
// — but a *count* needs no identity resolution, only distinct DIDs, so this stays
// cheap. Yourself is excluded. Bounded by `maxSeeds` (friend-scale guard so one
// pathological follow set can't fan out unboundedly — deeper reach is keeper work).
export async function countReachablePeople(
  myDID: string,
  r0DIDs: readonly string[],
  opts: { listFollows?: FollowsFetcher; maxSeeds?: number } = {},
): Promise<NetworkReach> {
  const listFn = opts.listFollows ?? defaultListFollows
  const maxSeeds = opts.maxSeeds ?? 200

  const r0 = new Set<string>()
  for (const d of r0DIDs) if (d && d !== myDID) r0.add(d)

  const reached = new Set<string>(r0)
  const seeds = [...r0].slice(0, maxSeeds)

  // One listFollows per seed, in parallel. A seed whose lookup fails just
  // contributes nothing — a flaky repo shouldn't zero out the whole count.
  const perSeed = await Promise.all(
    seeds.map((did) =>
      listFn(did)
        .then((follows) =>
          follows
            .map((f) => parseChannelAtURI(f.record.subject)?.authorDID)
            .filter((a): a is string => !!a),
        )
        .catch(() => [] as string[]),
    ),
  )
  for (const authors of perSeed) {
    for (const a of authors) if (a !== myDID) reached.add(a)
  }

  const direct = r0.size
  const total = reached.size
  return { direct, extended: total - direct, total }
}
