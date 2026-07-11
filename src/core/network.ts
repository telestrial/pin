import { AtpAgent } from '@atproto/api'
import { listFollows as defaultListFollows, parseChannelAtURI } from './follow'
import { getProfileRecord } from './profile'

const DEFAULT_SERVICE = 'https://bsky.social'

export type NetworkReach = {
  // R0: people whose channels you directly hold (subscription authors).
  direct: number
  // Everyone reached beyond R0 (R1+), that you don't already hold.
  extended: number
  // Distinct identities (DIDs) reachable within the walk, excluding yourself.
  total: number
}

// A public-follow-list fetcher, injectable for tests. Structurally a subset of
// `listFollows` (we only read each record's subject), so the real one drops in.
export type FollowsFetcher = (
  handleOrDID: string,
) => Promise<Array<{ record: { subject: string } }>>

// BFS over the follow graph outward from the people you hold. Returns the
// distinct DIDs reached, each mapped to its MINIMUM distance from you:
// 0 = held directly (R0), 1 = a person your R0 follows (R1), and so on.
// Yourself is always excluded.
//
// `hops` is how many follow-hops beyond R0 to walk (0 = just R0; 1 = R0 + their
// follows; ...). Reach depth is a parameter on purpose — a mention picker or
// search built on this widens its reach by raising `hops`, with no change to
// callers that consume the result. Per-ring fan-out is bounded by `maxSeeds`
// (friend-scale guard; deeper/unbounded crawl is keeper work). A seed whose
// follow-list lookup fails just contributes nothing.
export async function walkReachable(
  myDID: string,
  r0DIDs: readonly string[],
  opts: { listFollows?: FollowsFetcher; hops?: number; maxSeeds?: number } = {},
): Promise<Map<string, number>> {
  const listFn = opts.listFollows ?? defaultListFollows
  const hops = opts.hops ?? 1
  const maxSeeds = opts.maxSeeds ?? 200

  const distance = new Map<string, number>()
  let frontier: string[] = []
  for (const d of r0DIDs) {
    if (d && d !== myDID && !distance.has(d)) {
      distance.set(d, 0)
      frontier.push(d)
    }
  }

  for (let h = 1; h <= hops && frontier.length > 0; h++) {
    const seeds = frontier.slice(0, maxSeeds)
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
    const next: string[] = []
    for (const authors of perSeed) {
      for (const a of authors) {
        if (a && a !== myDID && !distance.has(a)) {
          distance.set(a, h)
          next.push(a)
        }
      }
    }
    frontier = next
  }

  return distance
}

// Count the distinct identities reachable through your network, one hop out
// (R0 + R1). A count needs no identity resolution — just distinct DIDs — so
// this stays cheap. Excludes yourself.
export async function countReachablePeople(
  myDID: string,
  r0DIDs: readonly string[],
  opts: { listFollows?: FollowsFetcher; hops?: number; maxSeeds?: number } = {},
): Promise<NetworkReach> {
  const distance = await walkReachable(myDID, r0DIDs, {
    ...opts,
    hops: opts.hops ?? 1,
  })
  let direct = 0
  for (const d of distance.values()) if (d === 0) direct++
  const total = distance.size
  return { direct, extended: total - direct, total }
}

// A reachable identity, resolved for display: enough to render a picker row
// (face + name) and record a pick (the DID). `distance` carries how far out
// they were found (0 = held directly), so a consumer can rank near-before-far.
export type ReachablePerson = {
  did: string
  handle: string
  username?: string
  avatarURL?: string
  distance: number
}

// Resolves a DID to its displayable identity. Injectable so the socialGraph
// harness (which has no atproto layer) can drive buildReachablePeople in tests.
export type IdentityResolver = (
  did: string,
) => Promise<{ handle: string; username?: string; avatarURL?: string } | null>

// Default resolver: DID → handle (describeRepo, unauthenticated) + Pin profile
// (username/avatar). Both best-effort; handle falls back to the DID so a person
// is never dropped just because their repo description failed.
async function defaultResolveIdentity(did: string) {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  const [repo, profile] = await Promise.all([
    agent.com.atproto.repo
      .describeRepo({ repo: did })
      .then((r) => r.data)
      .catch(() => null),
    getProfileRecord(did).catch(() => null),
  ])
  return {
    handle: repo?.handle ?? did,
    username: profile?.username,
    avatarURL: profile?.avatarURL,
  }
}

// The reachable-people index a mention picker (and, later, network search)
// draws its candidate pool from: walk the graph (reach depth via `hops`), then
// resolve each identity for display. Sorted nearest-first, then by name.
// Resolution is the cost here (one describeRepo + one profile fetch per person),
// so callers should cache the result per session; deeper reach (more people)
// is where progressive/lazy resolution will eventually earn its keep.
export async function buildReachablePeople(
  myDID: string,
  r0DIDs: readonly string[],
  opts: {
    listFollows?: FollowsFetcher
    hops?: number
    maxSeeds?: number
    resolve?: IdentityResolver
  } = {},
): Promise<ReachablePerson[]> {
  const distance = await walkReachable(myDID, r0DIDs, opts)
  const resolve = opts.resolve ?? defaultResolveIdentity

  const resolved = await Promise.all(
    [...distance.entries()].map(
      async ([did, dist]): Promise<ReachablePerson | null> => {
        const id = await resolve(did).catch(() => null)
        if (!id) return null
        return {
          did,
          distance: dist,
          handle: id.handle,
          username: id.username,
          avatarURL: id.avatarURL,
        }
      },
    ),
  )

  return resolved
    .filter((p): p is ReachablePerson => p !== null)
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        (a.username ?? a.handle).localeCompare(b.username ?? b.handle),
    )
}
