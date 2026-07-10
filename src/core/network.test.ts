import { describe, expect, it } from 'vitest'
import {
  HUGE_GRAPH,
  LARGE_GRAPH,
  MEDIUM_GRAPH,
  reachablePeople,
  STANDARD_GRAPH,
  type SyntheticGraph,
} from '../test/socialGraph'
import { channelAtURI } from './follow'
import { countReachablePeople, type FollowsFetcher } from './network'

const chan = (authorDID: string, cid = 'c1') =>
  `at://${authorDID}/dev.sia.pin.channel/${cid}`

// Build a fake follow-graph: did → the channel-author DIDs that did follows.
function fakeFollows(graph: Record<string, string[]>): FollowsFetcher {
  return async (did) =>
    (graph[did] ?? []).map((authorDID) => ({
      record: { subject: chan(authorDID) },
    }))
}

describe('countReachablePeople', () => {
  it('returns zeros when you hold no one', async () => {
    const r = await countReachablePeople('me', [], {
      listFollows: fakeFollows({}),
    })
    expect(r).toEqual({ direct: 0, extended: 0, total: 0 })
  })

  it('counts direct (R0) people, deduped and excluding self', async () => {
    const r = await countReachablePeople('me', ['a', 'a', 'b', 'me'], {
      listFollows: fakeFollows({}),
    })
    expect(r).toEqual({ direct: 2, extended: 0, total: 2 })
  })

  it('adds one-hop (R1) authors your follows follow', async () => {
    // R0 = {a, b}; a follows c,d; b follows d,e → R1 = {c, d, e}.
    const r = await countReachablePeople('me', ['a', 'b'], {
      listFollows: fakeFollows({ a: ['c', 'd'], b: ['d', 'e'] }),
    })
    expect(r).toEqual({ direct: 2, extended: 3, total: 5 })
  })

  it('does not double-count an R1 person who is also R0', async () => {
    // a follows b (already held) and c.
    const r = await countReachablePeople('me', ['a', 'b'], {
      listFollows: fakeFollows({ a: ['b', 'c'] }),
    })
    expect(r).toEqual({ direct: 2, extended: 1, total: 3 })
  })

  it('excludes yourself when reached one hop out', async () => {
    const r = await countReachablePeople('me', ['a'], {
      listFollows: fakeFollows({ a: ['me', 'c'] }),
    })
    expect(r).toEqual({ direct: 1, extended: 1, total: 2 }) // a, c
  })

  it('tolerates a seed whose follow-list lookup fails', async () => {
    const listFollows: FollowsFetcher = async (did) => {
      if (did === 'b') throw new Error('network')
      return [{ record: { subject: chan('c') } }]
    }
    const r = await countReachablePeople('me', ['a', 'b'], { listFollows })
    // a → c; b throws (contributes nothing); still counts a, b, c.
    expect(r.total).toBe(3)
  })

  it('respects maxSeeds without dropping unwalked seeds from the R0 count', async () => {
    const r = await countReachablePeople('me', ['a', 'b', 'c'], {
      listFollows: fakeFollows({ a: ['x'], b: ['y'], c: ['z'] }),
      maxSeeds: 1,
    })
    // Only 'a' is walked → R1 = {x}; b and c still count as directly held.
    expect(r).toEqual({ direct: 3, extended: 1, total: 4 })
  })

  it('ignores follow subjects that are not channel AT-URIs', async () => {
    const listFollows: FollowsFetcher = async () => [
      { record: { subject: 'at://did:x/app.bsky.feed.post/abc' } },
      { record: { subject: chan('c') } },
    ]
    const r = await countReachablePeople('me', ['a'], { listFollows })
    expect(r.total).toBe(2) // a, c — the bsky post subject is skipped
  })
})

// Validate the real walk against the shared socialGraph harness: drive it off a
// synthetic graph via a graph-backed follows fetcher, and cross-check its
// direct/total against reachablePeople — an *independent* computation over the
// same graph (it reads the structs directly; the walk goes through the fetcher
// + parseChannelAtURI, so agreement isn't tautological). Reach features built on
// this walk should extend these cases rather than hand-roll fixtures.
function graphListFollows(graph: SyntheticGraph): FollowsFetcher {
  const byDID = new Map(graph.users.map((u) => [u.did, u]))
  return async (did) => {
    const u = byDID.get(did)
    if (!u) return []
    // Each of this person's subscriptions is a follow of a channel owned by
    // sub.authorDID — the same subject shape production writes.
    return u.subscriptions.map((s) => ({
      record: { subject: channelAtURI(s.authorDID, s.channelID) },
    }))
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
      listFollows: graphListFollows(STANDARD_GRAPH),
    })
    // Hand-verified: R0 = {bob, carol}; carol follows dan → R1 adds dan; bob
    // follows only alice (the viewer, excluded). So 2 direct, 1 extended, 3 total.
    expect(reach).toEqual({ direct: 2, extended: 1, total: 3 })
    expect(reach.direct).toBe(reachablePeople(me, STANDARD_GRAPH, 1).length)
    expect(reach.total).toBe(reachablePeople(me, STANDARD_GRAPH, 2).length)
  })

  // One case per scale, each with its own budget — a merged assertion would hide
  // which scale regressed. The walk's cost is bounded by how many people you
  // hold (R0), not by total network size, so it stays flat as the graph grows;
  // the tripwire fails loudly if that ever stops being true. 2000ms is generous
  // headroom against CI variance, not a benchmark — don't raise it to pass.
  const REACH_CASES: { name: string; graph: SyntheticGraph; viewer: string }[] = [
    { name: 'STANDARD (~5 users)', graph: STANDARD_GRAPH, viewer: 'did:test:alice' },
    { name: 'MEDIUM (~50 users, +1 OOM)', graph: MEDIUM_GRAPH, viewer: 'did:test:user0' },
    { name: 'LARGE (~500 users, +2 OOM)', graph: LARGE_GRAPH, viewer: 'did:test:user0' },
    { name: 'HUGE (~10K users, +3 OOM)', graph: HUGE_GRAPH, viewer: 'did:test:user0' },
  ]

  it.each(REACH_CASES)(
    '$name matches the oracle within 2 seconds',
    async (c) => {
      const start = performance.now()
      const reach = await countReachablePeople(c.viewer, r0Of(c.graph, c.viewer), {
        listFollows: graphListFollows(c.graph),
      })
      const elapsedMs = performance.now() - start

      // Correctness gate — a perf check that doesn't assert the right answer is
      // a perf check silently passing on broken code.
      expect(reach.total).toBeGreaterThan(0)
      expect(reach.direct).toBe(reachablePeople(c.viewer, c.graph, 1).length)
      expect(reach.total).toBe(reachablePeople(c.viewer, c.graph, 2).length)
      expect(reach.extended).toBe(reach.total - reach.direct)

      expect(elapsedMs).toBeLessThan(2000)
    },
  )
})
