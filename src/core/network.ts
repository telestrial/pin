// Reachable-people graph walk — pure topology, no atproto, no Sia. The edges
// come from an injected ReachFetcher (in production: a person's identity-doc
// follows + handleFollows, resolved off pkarr — see lib/reach); identity
// resolution for display comes from an injected IdentityResolver. Injecting
// both keeps this a pure BFS the socialGraph harness can drive over a synthetic
// graph — and keeps core free of the pkarr/Sia layer.

export type NetworkReach = {
  // R0: people whose channels you directly hold (subscription authors).
  direct: number
  // Everyone reached beyond R0 (R1+), that you don't already hold.
  extended: number
  // Distinct identities reachable within the walk, excluding yourself.
  total: number
}

// Given a person's id (a did:dht), the ids of everyone they publicly connect
// to (channel-follow authors + handle-follows). Injectable for tests.
export type ReachFetcher = (id: string) => Promise<string[]>

// BFS over the follow graph outward from the people you hold. Returns the
// distinct ids reached, each mapped to its MINIMUM distance: 0 = held directly
// (R0), 1 = a person your R0 connects to (R1), and so on. Yourself is excluded.
//
// `hops` is how many hops beyond R0 to walk (0 = just R0; 1 = R0 + their
// connections; …). Reach depth is a parameter on purpose — a mention picker or
// search widens its reach by raising `hops`, with no change to consumers of the
// result. Per-ring fan-out is bounded by `maxSeeds` (friend-scale guard; deeper
// crawl is keeper work). A seed whose lookup fails contributes nothing.
export async function walkReachable(
  myId: string,
  r0: readonly string[],
  opts: { fetch: ReachFetcher; hops?: number; maxSeeds?: number },
): Promise<Map<string, number>> {
  const fetchFn = opts.fetch
  const hops = opts.hops ?? 1
  const maxSeeds = opts.maxSeeds ?? 200

  const distance = new Map<string, number>()
  let frontier: string[] = []
  for (const d of r0) {
    if (d && d !== myId && !distance.has(d)) {
      distance.set(d, 0)
      frontier.push(d)
    }
  }

  for (let h = 1; h <= hops && frontier.length > 0; h++) {
    const seeds = frontier.slice(0, maxSeeds)
    const perSeed = await Promise.all(
      seeds.map((id) => fetchFn(id).catch(() => [] as string[])),
    )
    const next: string[] = []
    for (const connections of perSeed) {
      for (const a of connections) {
        if (a && a !== myId && !distance.has(a)) {
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
// (R0 + R1). A count needs no identity resolution — just distinct ids — so this
// stays cheap. Excludes yourself.
export async function countReachablePeople(
  myId: string,
  r0: readonly string[],
  opts: { fetch: ReachFetcher; hops?: number; maxSeeds?: number },
): Promise<NetworkReach> {
  const distance = await walkReachable(myId, r0, {
    ...opts,
    hops: opts.hops ?? 1,
  })
  let direct = 0
  for (const d of distance.values()) if (d === 0) direct++
  const total = distance.size
  return { direct, extended: total - direct, total }
}

// A reachable identity, resolved for display: enough to render a picker row
// (face + name) and record a pick (the id/did:dht). `distance` carries how far
// out they were found (0 = held directly), so a consumer can rank near-first.
export type ReachablePerson = {
  did: string
  handle: string
  username?: string
  avatarURL?: string
  distance: number
}

// Resolves an id to its displayable identity. Injectable so the socialGraph
// harness (no pkarr layer) can drive buildReachablePeople in tests.
export type IdentityResolver = (
  id: string,
) => Promise<{ handle: string; username?: string; avatarURL?: string } | null>

// The reachable-people index a mention picker (and, later, network search)
// draws its candidate pool from: walk the graph (depth via `hops`), then resolve
// each identity for display. Sorted nearest-first, then by name. Resolution is
// the cost here, so callers should cache the result per session; deeper reach is
// where progressive/lazy resolution will eventually earn its keep.
export async function buildReachablePeople(
  myId: string,
  r0: readonly string[],
  opts: {
    fetch: ReachFetcher
    resolve: IdentityResolver
    hops?: number
    maxSeeds?: number
  },
): Promise<ReachablePerson[]> {
  const distance = await walkReachable(myId, r0, opts)
  const resolve = opts.resolve

  const resolved = await Promise.all(
    [...distance.entries()].map(
      async ([id, dist]): Promise<ReachablePerson | null> => {
        const idr = await resolve(id).catch(() => null)
        if (!idr) return null
        return {
          did: id,
          distance: dist,
          handle: idr.handle,
          username: idr.username,
          avatarURL: idr.avatarURL,
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
