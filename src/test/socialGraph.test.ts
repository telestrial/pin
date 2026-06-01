import { describe, expect, it } from 'vitest'
import type { SearchResult, SyntheticGraph } from './socialGraph'
import {
  buildGraph,
  HUGE_GRAPH,
  LARGE_GRAPH,
  MEDIUM_GRAPH,
  reachableChannels,
  search,
  STANDARD_GRAPH,
} from './socialGraph'

describe('STANDARD_GRAPH', () => {
  it('contains five users', () => {
    expect(STANDARD_GRAPH.users.map((u) => u.handle)).toEqual([
      'alice',
      'bob',
      'carol',
      'dan',
      'eve',
    ])
  })

  it('alice owns one channel; carol owns two', () => {
    const alice = STANDARD_GRAPH.users.find((u) => u.handle === 'alice')!
    const carol = STANDARD_GRAPH.users.find((u) => u.handle === 'carol')!
    expect(alice.channels.map((c) => c.manifest.name)).toEqual(['daily'])
    expect(carol.channels.map((c) => c.manifest.name)).toEqual([
      'rust',
      'coffee',
    ])
  })

  it('each channel manifest carries items in newest-first order', () => {
    const bob = STANDARD_GRAPH.users.find((u) => u.handle === 'bob')!
    const pets = bob.channels[0]!
    const timestamps = pets.manifest.items.map((i) => i.publishedAt)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1] > timestamps[i]).toBe(true)
    }
  })
})

describe('reachableChannels', () => {
  it("returns alice's two direct subscriptions", () => {
    const aliceDID = 'did:test:alice'
    const reach = reachableChannels(aliceDID, STANDARD_GRAPH)
    expect(
      reach.map((c) => `${c.ownerHandle}/${c.manifest.name}`).sort(),
    ).toEqual(['bob/pets', 'carol/rust'])
  })

  it('returns empty for eve who has no subscriptions', () => {
    const eveDID = 'did:test:eve'
    expect(reachableChannels(eveDID, STANDARD_GRAPH)).toEqual([])
  })

  it('returns empty for an unknown viewer DID', () => {
    expect(reachableChannels('did:test:nobody', STANDARD_GRAPH)).toEqual([])
  })

  it("excludes the viewer's own channels (R0 is subs-only)", () => {
    const aliceDID = 'did:test:alice'
    const reach = reachableChannels(aliceDID, STANDARD_GRAPH)
    expect(reach.map((c) => c.ownerHandle)).not.toContain('alice')
  })
})

describe('search', () => {
  const aliceDID = 'did:test:alice'

  it('finds items whose body contains the query', () => {
    const results = search(aliceDID, 'cats', STANDARD_GRAPH)
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.channel.ownerHandle === 'bob')).toBe(true)
  })

  it('is case-insensitive', () => {
    const lower = search(aliceDID, 'cats', STANDARD_GRAPH)
    const upper = search(aliceDID, 'CATS', STANDARD_GRAPH)
    expect(upper).toEqual(lower)
  })

  it("returns nothing for keywords outside alice's reach", () => {
    // No coffee channel in alice's subs.
    expect(search(aliceDID, 'coffee', STANDARD_GRAPH)).toEqual([])
    // eve's hidden channel isn't subscribed.
    expect(search(aliceDID, 'secret', STANDARD_GRAPH)).toEqual([])
  })

  it("excludes the viewer's own posts (reach is subs-only)", () => {
    // 'running' is in alice's own daily channel.
    expect(search(aliceDID, 'running', STANDARD_GRAPH)).toEqual([])
  })

  it('matches on channel name when body and title do not', () => {
    // None of bob/pets' items mention "pets" in body or title.
    const results = search(aliceDID, 'pets', STANDARD_GRAPH)
    expect(results.length).toBe(3)
    expect(results.every((r) => r.matched === 'channelName')).toBe(true)
  })

  it('prefers title over body when both match', () => {
    // Item 'On cats' has title containing 'on cats'; body also matches 'on'.
    const results = search(aliceDID, 'on cats', STANDARD_GRAPH)
    const onCats = results.find((r) => r.item.title === 'On cats')
    expect(onCats?.matched).toBe('title')
  })

  it('returns empty for empty or whitespace-only queries', () => {
    expect(search(aliceDID, '', STANDARD_GRAPH)).toEqual([])
    expect(search(aliceDID, '   ', STANDARD_GRAPH)).toEqual([])
  })

  it('returns empty for an unknown viewer', () => {
    expect(search('did:test:nobody', 'anything', STANDARD_GRAPH)).toEqual([])
  })

  it('sorts results newest-first by item.publishedAt', () => {
    const danDID = 'did:test:dan'
    // dan subscribes to carol/rust and alice/daily; both contain items.
    const results = search(danDID, 'a', STANDARD_GRAPH)
    expect(results.length).toBeGreaterThan(1)
    for (let i = 1; i < results.length; i++) {
      expect(
        results[i - 1]!.item.publishedAt >= results[i]!.item.publishedAt,
      ).toBe(true)
    }
  })
})

// Tripwire, not a benchmark. The point isn't to verify search is fast —
// the point is to fail loudly if search becomes pathologically slow as
// graph fixtures or reach rules grow. Today's R0 returns sub-millisecond
// at every scale below; 2000ms is generous headroom against CI variance,
// JIT warmup, GC pauses. When any tripwire trips, something is wrong;
// the budget should not be raised to make it pass.
//
// One case per graph scale so each scale gets its own independent budget
// — different sizes have different intrinsic costs and a merged
// assertion would hide which scale regressed. As we add reach rules
// (R1 citation-walk, R2 vouch-graph), each new rule gets its own
// `it.each` block alongside this one.
type TripwireCase = {
  name: string
  graph: SyntheticGraph
  viewerDID: string
  query: string
  // Optional per-case correctness check beyond `results.length > 0`. For
  // STANDARD we can assert specific provenance; for scaled graphs with
  // random topologies, the universal-query `post` is the strongest
  // assertion that doesn't couple to PRNG state.
  extraAssert?: (results: SearchResult[]) => void
}

const TRIPWIRE_CASES: TripwireCase[] = [
  {
    name: 'STANDARD_GRAPH (~5 users)',
    graph: STANDARD_GRAPH,
    viewerDID: 'did:test:alice',
    query: 'cats',
    extraAssert: (r) => {
      // 'cats' lives only in bob/pets; alice subscribes. All results
      // must trace back to bob.
      expect(r.every((x) => x.channel.ownerHandle === 'bob')).toBe(true)
    },
  },
  {
    name: 'MEDIUM_GRAPH (~50 users, +1 OOM)',
    graph: MEDIUM_GRAPH,
    viewerDID: 'did:test:user0',
    query: 'post',
  },
  {
    name: 'LARGE_GRAPH (~500 users, +2 OOM)',
    graph: LARGE_GRAPH,
    viewerDID: 'did:test:user0',
    query: 'post',
  },
  {
    name: 'HUGE_GRAPH (~10K users, +3 OOM)',
    graph: HUGE_GRAPH,
    viewerDID: 'did:test:user0',
    query: 'post',
  },
]

describe('R0 search performance (tripwire)', () => {
  it.each(TRIPWIRE_CASES)('$name returns within 2 seconds', (c) => {
    const start = performance.now()
    const results = search(c.viewerDID, c.query, c.graph)
    const elapsedMs = performance.now() - start

    // Correctness gate — a perf check that doesn't also assert the
    // right answer is a perf check silently passing on broken code.
    expect(results.length).toBeGreaterThan(0)
    c.extraAssert?.(results)

    expect(elapsedMs).toBeLessThan(2000)
  })
})

describe('buildGraph builder', () => {
  it('throws on duplicate user', () => {
    expect(() => buildGraph().addUser('a').addUser('a').build()).toThrow()
  })

  it('throws on unknown user reference', () => {
    expect(() =>
      buildGraph().addChannel('nobody', 'whatever').build(),
    ).toThrow()
  })

  it('throws on unknown channel reference', () => {
    expect(() =>
      buildGraph().addUser('a').publish('a', 'no-such-channel', 'body').build(),
    ).toThrow()
  })

  it('subscribe is idempotent', () => {
    const graph = buildGraph()
      .addUser('a')
      .addUser('b')
      .addChannel('b', 'channel')
      .subscribe('a', 'b', 'channel')
      .subscribe('a', 'b', 'channel')
      .build()
    const a = graph.users.find((u) => u.handle === 'a')!
    expect(a.subscriptions.length).toBe(1)
  })
})
