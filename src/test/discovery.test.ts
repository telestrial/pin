// The discovery crawl, simulated over whole graphs.
//
// `frontier` decides who the Curator reads next, and it is pure — so the interesting
// questions about it are not about one call but about many passes: does coverage converge,
// how many passes does a given budget need, and does anybody get left permanently last.
// None of that is visible in a unit test of the ordering, and none of it should have to
// wait for a live run to find out.
//
// So this drives THE REAL RUST FUNCTION over the socialGraph fixtures, one pass at a time,
// feeding each pass's resolutions back in as held records — the same loop the Curator runs,
// with the network replaced by a lookup. Cross-checked against `reachablePeople`, which is
// an independent computation over the same graph rather than this walk agreeing with
// itself.

import { beforeAll, describe, expect, it } from 'vitest'
import {
  discovery_budget,
  discovery_frontier,
  discovery_full_cap,
  discovery_refresh_share,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import {
  HUGE_GRAPH,
  LARGE_GRAPH,
  MEDIUM_GRAPH,
  reachablePeople,
  STANDARD_GRAPH,
  type SyntheticGraph,
} from './socialGraph'

/** Who a person points at: the authors of the channels they follow — the same people-edges
 *  an identity-doc's follows resolve to in production, and the same ones `network.test.ts`
 *  walks. */
function edgesOf(graph: SyntheticGraph, did: string): string[] {
  const u = graph.users.find((x) => x.did === did)
  if (!u) return []
  return [...new Set(u.subscriptions.map((s) => s.authorDID))]
}

function r0Of(graph: SyntheticGraph, viewerDID: string): string[] {
  const u = graph.users.find((x) => x.did === viewerDID)
  if (!u) return []
  return [...new Set(u.subscriptions.map((s) => s.authorDID))]
}

type Candidate = {
  did: string
  distance: number
  references: number
  nominated: boolean
}

function nextToRead(
  r0: string[],
  held: Map<string, string[]>,
  nominations: string[] = [],
): Candidate[] {
  return JSON.parse(
    discovery_frontier(
      JSON.stringify(r0),
      JSON.stringify(Object.fromEntries(held)),
      JSON.stringify(nominations),
    ),
  ) as Candidate[]
}

type Run = {
  held: Map<string, string[]>
  /** How many identities were held after each pass — the coverage curve. */
  coverage: number[]
  /** The order identities were read in, across all passes. */
  order: string[]
}

/** Run the crawl until the frontier empties or the pass limit is hit.
 *
 *  `held` is seeded with this identity's own graph, because that is what the ENGAGEMENT
 *  crawl reads — discovery expands outward from what that loop has already brought in, and
 *  has nothing to expand from before it runs. */
function crawl(
  graph: SyntheticGraph,
  viewer: string,
  budget: number,
  maxPasses = 5000,
): Run {
  // Two different sets, and conflating them is how the crawl ends up reading YOU. What
  // engagement covers includes this identity itself, so passing it keeps you off your own
  // frontier — somebody in your graph following one of your channels otherwise names you
  // as a candidate. What is HELD does not include you: your own directory is assembled
  // from local state and is never a record of a crawl.
  const r0 = [...r0Of(graph, viewer), viewer]
  const held = new Map<string, string[]>()
  for (const did of r0Of(graph, viewer)) held.set(did, edgesOf(graph, did))

  const coverage: number[] = []
  const order: string[] = []
  for (let pass = 0; pass < maxPasses; pass++) {
    const candidates = nextToRead(r0, held)
    if (candidates.length === 0) break
    for (const c of candidates.slice(0, budget)) {
      held.set(c.did, edgesOf(graph, c.did))
      order.push(c.did)
    }
    coverage.push(held.size)
  }
  return { held, coverage, order }
}

/** Everyone reachable from the viewer at all, by the independent oracle. Enough hops to
 *  exhaust any of these graphs, so this is the transitive closure. */
function everyoneReachable(graph: SyntheticGraph, viewer: string): Set<string> {
  return new Set(reachablePeople(viewer, graph, graph.users.length))
}

describe('the discovery crawl over synthetic graphs', () => {
  beforeAll(async () => {
    await ensureWasm()
  })

  it('reads nothing until the engagement crawl has read your own graph', async () => {
    // The dependency between the two loops, and the reason discovery is not the thing that
    // starts a cold account moving: the frontier is derived from held records, so with
    // none it is empty. Discovery widens what engagement has already brought in.
    expect(
      nextToRead(r0Of(STANDARD_GRAPH, 'did:test:alice'), new Map()),
    ).toEqual([])
  })

  it('converges on everyone reachable, checked against the oracle', () => {
    const viewer = 'did:test:alice'
    const { held } = crawl(
      STANDARD_GRAPH,
      viewer,
      discovery_budget() - discovery_refresh_share(),
    )

    // Not "the crawl agrees with itself": `reachablePeople` walks the same graph by a
    // different route, so agreeing with it is evidence rather than a tautology.
    expect(new Set(held.keys())).toEqual(
      everyoneReachable(STANDARD_GRAPH, viewer),
    )
  })

  it('reads everyone eventually, even one at a time', () => {
    // The starvation check, at the tightest budget there is. What it proves is that on a
    // FINITE graph every reachable identity is read — an ordering that quietly dropped the
    // lightly-referenced tail, or re-offered people already held, fails here and passes
    // every single-pass test. What it cannot prove is behaviour on a graph that grows
    // faster than the crawl reads, where a corroboration-preferring order could keep an
    // old candidate perpetually behind newer ones; that is a live-network question.
    const viewer = 'did:test:user0'
    const { held, order } = crawl(MEDIUM_GRAPH, viewer, 1)

    const reachable = everyoneReachable(MEDIUM_GRAPH, viewer)
    expect(new Set(held.keys())).toEqual(reachable)
    // Read once each, never re-queued: a candidate that came back around would be a pass
    // spent on somebody already held.
    expect(new Set(order).size).toBe(order.length)
  })

  it('spends a bigger budget on fewer passes, and both finish', () => {
    // How the budget constant gets chosen from evidence rather than taste. The work is
    // the same either way — every reachable identity is read exactly once — so what a
    // budget buys is wall-clock, and what it costs is DHT resolves and Sia downloads
    // bunched into one pass.
    const viewer = 'did:test:user0'
    const reachable = everyoneReachable(LARGE_GRAPH, viewer)

    const slow = crawl(LARGE_GRAPH, viewer, 1)
    const fast = crawl(LARGE_GRAPH, viewer, 32)

    expect(new Set(slow.held.keys())).toEqual(reachable)
    expect(new Set(fast.held.keys())).toEqual(reachable)
    expect(fast.coverage.length).toBeLessThan(slow.coverage.length)
    // Coverage only ever grows: a pass that lost ground would mean the frontier had
    // re-offered somebody already read.
    for (const run of [slow, fast]) {
      for (let i = 1; i < run.coverage.length; i++) {
        expect(run.coverage[i]).toBeGreaterThan(run.coverage[i - 1])
      }
    }
  })

  it('reads the same people in the same order every time', () => {
    // Two instances of one identity compute this independently from a doc they both hold.
    // Disagreeing would have each resolving what the other did not, which is not a
    // division of labour — it is the same work done twice on two schedules.
    const viewer = 'did:test:user0'
    const first = crawl(MEDIUM_GRAPH, viewer, discovery_budget())
    const again = crawl(MEDIUM_GRAPH, viewer, discovery_budget())
    expect(first.order).toEqual(again.order)
  })

  it('reads somebody asked for before the graph', () => {
    // A nomination is written when a screen reached for someone and had to go to the
    // network to answer. It is the only input that does not come from the graph, and it
    // outranks everything that does.
    const viewer = 'did:test:alice'
    const r0 = r0Of(STANDARD_GRAPH, viewer)
    const held = new Map<string, string[]>()
    for (const did of r0) held.set(did, edgesOf(STANDARD_GRAPH, did))

    const plain = nextToRead(r0, held)
    expect(plain.length).toBeGreaterThan(0)
    const last = plain[plain.length - 1].did

    const nominated = nextToRead(r0, held, [last])
    expect(nominated[0].did).toBe(last)
    expect(nominated[0].nominated).toBe(true)
  })

  // SCALES is declared further down; the describe body finishes before any test callback
  // runs, so referencing it here is fine and keeps the tripwire beside the cases it uses.
  it('reports what the shipped constants cost at each scale', () => {
    // The numbers behind the two tuning choices, measured rather than guessed: how much of
    // the graph the crawl holds in full, how long the refresh rotation takes to come back
    // round to any one of them, and how long a cold start takes to see everybody. All of it
    // falls out of constants the Curator actually uses, so changing one moves this table.
    //
    // Coverage is SIMULATED up to LARGE and projected for HUGE, because ten thousand
    // identities at five a pass is two thousand passes and this tier has to stay quick.
    // The projection is `reachable / perPass`, and it is checked against the simulation on
    // every scale where both are affordable — so the one projected number rests on a model
    // that was verified rather than assumed.
    const cadenceMins = 10
    const perPass = discovery_budget() - discovery_refresh_share()
    const days = (passes: number) =>
      +((passes * cadenceMins) / 60 / 24).toFixed(1)

    const rows = SCALES.map((c) => {
      const reachable = everyoneReachable(c.graph, c.viewer).size
      const projected = Math.ceil(reachable / perPass)
      const simulate = c.graph !== HUGE_GRAPH
      const passes = simulate
        ? crawl(c.graph, c.viewer, perPass).coverage.length
        : projected

      // The model, checked wherever simulating is affordable. A frontier that stays wider
      // than the budget means every pass spends all of it, so coverage is just division —
      // and if that stops being true, the projection below stops meaning anything.
      if (simulate) expect(Math.abs(passes - projected)).toBeLessThanOrEqual(2)

      const full = Math.min(reachable, discovery_full_cap())
      return {
        scale: c.name,
        reachable,
        'days to cover': days(passes) + (simulate ? '' : ' (projected)'),
        'held full': full,
        'refresh period (days)': days(
          Math.ceil(full / discovery_refresh_share()),
        ),
      }
    })
    // Printed for whoever is tuning the constants. The runner swallows console output on a
    // passing test, so the ASSERTIONS below are what actually holds the line — this is a
    // convenience for a person changing `MAX_FULL` or `REFRESH_PER_PASS` and wanting to see
    // what it did.
    console.table(rows)

    // Gated, so this is a measurement rather than a print statement: every scale has
    // somebody to find, and the near set comes round inside a month or a held profile could
    // be a season out of date.
    for (const r of rows) {
      expect(r.reachable).toBeGreaterThan(0)
      expect(
        Number.parseFloat(r['refresh period (days)'] as never),
      ).toBeLessThan(30)
    }
  })

  // One case per scale, each with its own budget — a merged assertion would hide which
  // scale regressed. 2000ms is headroom against CI variance, not a benchmark — don't
  // raise it to pass.
  const SCALES: { name: string; graph: SyntheticGraph; viewer: string }[] = [
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

  // ONE PASS at each scale, against a fully-crawled graph — the worst case the frontier
  // ever faces, since it is recomputed from every held record each time and that set only
  // grows. Measuring a whole convergence instead would measure the wrong thing: covering
  // ten thousand identities at eight per pass is over a thousand passes, and in production
  // those are minutes apart, so what has to stay cheap is the pass, not the total.
  it.each(
    SCALES,
  )('$name computes a pass within 2 seconds when fully crawled', (c) => {
    const r0 = [...r0Of(c.graph, c.viewer), c.viewer]
    const held = new Map<string, string[]>()
    for (const did of everyoneReachable(c.graph, c.viewer)) {
      held.set(did, edgesOf(c.graph, did))
    }

    const start = performance.now()
    const candidates = nextToRead(r0, held)
    const elapsedMs = performance.now() - start

    // Correctness gate first — a perf check that doesn't assert the right answer is a
    // perf check silently passing on broken code. Everything reachable is held, so there
    // is nothing left to read.
    expect(held.size).toBeGreaterThan(0)
    expect(candidates).toEqual([])

    expect(elapsedMs).toBeLessThan(2000)
  })
})
