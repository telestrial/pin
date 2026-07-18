import { describe, expect, it } from 'vitest'
import {
  HUGE_GRAPH,
  LARGE_GRAPH,
  MEDIUM_GRAPH,
  reachablePeople,
  STANDARD_GRAPH,
  type SyntheticGraph,
} from '../test/socialGraph'
import {
  buildReachablePeople,
  countReachablePeople,
  type IdentityResolver,
  type ReachFetcher,
  walkReachable,
} from './network'

// A fake reach graph: id → the ids that id connects to.
function fakeReach(graph: Record<string, string[]>): ReachFetcher {
  return async (id) => graph[id] ?? []
}

describe('countReachablePeople', () => {
  it('returns zeros when you hold no one', async () => {
    const r = await countReachablePeople('me', [], { fetch: fakeReach({}) })
    expect(r).toEqual({ direct: 0, extended: 0, total: 0 })
  })

  it('counts direct (R0) people, deduped and excluding self', async () => {
    const r = await countReachablePeople('me', ['a', 'a', 'b', 'me'], {
      fetch: fakeReach({}),
    })
    expect(r).toEqual({ direct: 2, extended: 0, total: 2 })
  })

  it('adds one-hop (R1) people your follows connect to', async () => {
    // R0 = {a, b}; a → c,d; b → d,e → R1 = {c, d, e}.
    const r = await countReachablePeople('me', ['a', 'b'], {
      fetch: fakeReach({ a: ['c', 'd'], b: ['d', 'e'] }),
    })
    expect(r).toEqual({ direct: 2, extended: 3, total: 5 })
  })

  it('does not double-count an R1 person who is also R0', async () => {
    // a → b (already held) and c.
    const r = await countReachablePeople('me', ['a', 'b'], {
      fetch: fakeReach({ a: ['b', 'c'] }),
    })
    expect(r).toEqual({ direct: 2, extended: 1, total: 3 })
  })

  it('excludes yourself when reached one hop out', async () => {
    const r = await countReachablePeople('me', ['a'], {
      fetch: fakeReach({ a: ['me', 'c'] }),
    })
    expect(r).toEqual({ direct: 1, extended: 1, total: 2 }) // a, c
  })

  it('tolerates a seed whose lookup fails', async () => {
    const fetch: ReachFetcher = async (id) => {
      if (id === 'b') throw new Error('network')
      return ['c']
    }
    const r = await countReachablePeople('me', ['a', 'b'], { fetch })
    // a → c; b throws (contributes nothing); still counts a, b, c.
    expect(r.total).toBe(3)
  })

  it('respects maxSeeds without dropping unwalked seeds from the R0 count', async () => {
    const r = await countReachablePeople('me', ['a', 'b', 'c'], {
      fetch: fakeReach({ a: ['x'], b: ['y'], c: ['z'] }),
      maxSeeds: 1,
    })
    // Only 'a' is walked → R1 = {x}; b and c still count as directly held.
    expect(r).toEqual({ direct: 3, extended: 1, total: 4 })
  })
})

// Validate the real walk against the shared socialGraph harness: drive it off a
// synthetic graph via a graph-backed reach fetcher, and cross-check its
// direct/total against reachablePeople — an *independent* computation over the
// same graph. Reach features built on this walk should extend these cases
// rather than hand-roll fixtures.
function graphReach(graph: SyntheticGraph): ReachFetcher {
  const byDID = new Map(graph.users.map((u) => [u.did, u]))
  return async (did) => {
    const u = byDID.get(did)
    if (!u) return []
    // A person connects to the authors of the channels they follow — the same
    // people-edges the identity-doc's follows resolve to in production.
    return [...new Set(u.subscriptions.map((s) => s.authorDID))]
  }
}

function r0Of(graph: SyntheticGraph, viewerDID: string): string[] {
  const u = graph.users.find((x) => x.did === viewerDID)
  if (!u) return []
  return [...new Set(u.subscriptions.map((s) => s.authorDID))]
}

describe('countReachablePeople against the socialGraph harness', () => {
  it('matches the reachablePeople oracle for alice in STANDARD_GRAPH', async () => {
    const me = 'did:test:alice'
    const reach = await countReachablePeople(me, r0Of(STANDARD_GRAPH, me), {
      fetch: graphReach(STANDARD_GRAPH),
    })
    // Hand-verified: R0 = {bob, carol}; carol → dan → R1 adds dan; bob → alice
    // (the viewer, excluded). So 2 direct, 1 extended, 3 total.
    expect(reach).toEqual({ direct: 2, extended: 1, total: 3 })
    expect(reach.direct).toBe(reachablePeople(me, STANDARD_GRAPH, 1).length)
    expect(reach.total).toBe(reachablePeople(me, STANDARD_GRAPH, 2).length)
  })

  // One case per scale, each with its own budget — a merged assertion would hide
  // which scale regressed. The walk's cost is bounded by how many people you
  // hold (R0), not by total network size, so it stays flat as the graph grows;
  // the tripwire fails loudly if that ever stops being true. 2000ms is generous
  // headroom against CI variance, not a benchmark — don't raise it to pass.
  const REACH_CASES: { name: string; graph: SyntheticGraph; viewer: string }[] =
    [
      {
        name: 'STANDARD (~5 users)',
        graph: STANDARD_GRAPH,
        viewer: 'did:test:alice',
      },
      {
        name: 'MEDIUM (~50 users, +1 OOM)',
        graph: MEDIUM_GRAPH,
        viewer: 'did:test:user0',
      },
      {
        name: 'LARGE (~500 users, +2 OOM)',
        graph: LARGE_GRAPH,
        viewer: 'did:test:user0',
      },
      {
        name: 'HUGE (~10K users, +3 OOM)',
        graph: HUGE_GRAPH,
        viewer: 'did:test:user0',
      },
    ]

  it.each(
    REACH_CASES,
  )('$name matches the oracle within 2 seconds', async (c) => {
    const start = performance.now()
    const reach = await countReachablePeople(
      c.viewer,
      r0Of(c.graph, c.viewer),
      { fetch: graphReach(c.graph) },
    )
    const elapsedMs = performance.now() - start

    // Correctness gate — a perf check that doesn't assert the right answer is
    // a perf check silently passing on broken code.
    expect(reach.total).toBeGreaterThan(0)
    expect(reach.direct).toBe(reachablePeople(c.viewer, c.graph, 1).length)
    expect(reach.total).toBe(reachablePeople(c.viewer, c.graph, 2).length)
    expect(reach.extended).toBe(reach.total - reach.direct)

    expect(elapsedMs).toBeLessThan(2000)
  })
})

describe('walkReachable', () => {
  it('keeps R0 people at distance 0 even if also reached one hop out', async () => {
    // a → b (also R0) and c. b must not be demoted to distance 1.
    const dist = await walkReachable('me', ['a', 'b'], {
      fetch: fakeReach({ a: ['b', 'c'] }),
    })
    expect(dist.get('a')).toBe(0)
    expect(dist.get('b')).toBe(0)
    expect(dist.get('c')).toBe(1)
  })

  it('hops:0 returns only R0', async () => {
    const dist = await walkReachable('me', ['a'], {
      fetch: fakeReach({ a: ['b'] }),
      hops: 0,
    })
    expect([...dist.keys()]).toEqual(['a'])
  })

  it('hops:2 reaches two rings out with increasing distance', async () => {
    const dist = await walkReachable('me', ['a'], {
      fetch: fakeReach({ a: ['b'], b: ['c'] }),
      hops: 2,
    })
    expect(dist.get('a')).toBe(0)
    expect(dist.get('b')).toBe(1)
    expect(dist.get('c')).toBe(2)
  })
})

// The picker's candidate provider — walk + identity resolution — against the
// harness, with a graph-backed resolver standing in for identity-doc profiles.
function graphResolver(graph: SyntheticGraph): IdentityResolver {
  const byDID = new Map(graph.users.map((u) => [u.did, u]))
  return async (did) => {
    const u = byDID.get(did)
    return u ? { handle: u.handle } : null
  }
}

describe('buildReachablePeople', () => {
  const me = 'did:test:alice'

  it('resolves the reachable set with correct distances (STANDARD_GRAPH)', async () => {
    const people = await buildReachablePeople(me, r0Of(STANDARD_GRAPH, me), {
      fetch: graphReach(STANDARD_GRAPH),
      resolve: graphResolver(STANDARD_GRAPH),
    })
    expect(people.map((p) => p.did).sort()).toEqual(
      ['did:test:bob', 'did:test:carol', 'did:test:dan'].sort(),
    )
    const dist = Object.fromEntries(people.map((p) => [p.did, p.distance]))
    expect(dist['did:test:bob']).toBe(0) // R0
    expect(dist['did:test:carol']).toBe(0) // R0
    expect(dist['did:test:dan']).toBe(1) // R1 via carol
    expect(people.find((p) => p.did === 'did:test:bob')?.handle).toBe('bob')
  })

  it('sorts nearest-first (non-decreasing distance)', async () => {
    const people = await buildReachablePeople(me, r0Of(STANDARD_GRAPH, me), {
      fetch: graphReach(STANDARD_GRAPH),
      resolve: graphResolver(STANDARD_GRAPH),
    })
    for (let i = 1; i < people.length; i++) {
      expect(people[i - 1]!.distance).toBeLessThanOrEqual(people[i]!.distance)
    }
  })

  it('drops people the resolver can’t resolve', async () => {
    const resolve: IdentityResolver = async (did) =>
      did === 'did:test:dan' ? null : { handle: did.replace('did:test:', '') }
    const people = await buildReachablePeople(me, r0Of(STANDARD_GRAPH, me), {
      fetch: graphReach(STANDARD_GRAPH),
      resolve,
    })
    expect(people.map((p) => p.did)).not.toContain('did:test:dan')
  })
})
