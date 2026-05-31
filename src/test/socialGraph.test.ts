import { describe, expect, it } from 'vitest'
import {
  buildGraph,
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
// the graph fixture or the reach rule grows. Today's STANDARD_GRAPH +
// R0 returns in sub-millisecond; 2000ms is ~6 orders of magnitude of
// headroom, generous enough to survive CI variance, JIT warmup, GC
// pauses. When this trips, something is wrong; the budget should not
// be raised to make it pass.
//
// As we add reach rules (R1 citation-walk, R2 vouch-graph, etc.) and
// scale the standard graph, add one tripwire per rule. Don't merge
// them into one assertion — different rules have different complexity
// profiles and deserve independent budgets.
describe('search performance (tripwire)', () => {
  it('R0 + STANDARD_GRAPH returns within 2 seconds', () => {
    const aliceDID = 'did:test:alice'
    const start = performance.now()
    const results = search(aliceDID, 'cats', STANDARD_GRAPH)
    const elapsedMs = performance.now() - start

    // Correctness gate — a perf check that doesn't also assert the
    // right answer is a perf check that's silently passing on broken
    // code. cats is in bob/pets only; alice subscribes; result must
    // be non-empty and all from bob.
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.channel.ownerHandle === 'bob')).toBe(true)

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
