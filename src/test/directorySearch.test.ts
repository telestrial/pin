// Finding a person or a channel in what the crawl has read.
//
// The index is the only corpus Pin has that nobody handed you, so this is the first way to
// find a channel other than being sent a link. What that makes load-bearing is COVERAGE: a
// query that quietly misses half the corpus is indistinguishable from a network where
// nobody published anything, which is why the cases below are checked against an oracle
// that walks the graph rather than against the implementation's own answer.

import { describe, expect, it } from 'vitest'
import {
  MAX_HITS,
  type SearchablePerson,
  searchDirectories,
} from '../core/directorySearch'
import {
  HUGE_GRAPH,
  LARGE_GRAPH,
  MEDIUM_GRAPH,
  STANDARD_GRAPH,
  type SyntheticGraph,
} from './socialGraph'

/** The graph as the crawl would have recorded it: one directory per identity, carrying
 *  their profile and the channels they advertise. */
function asIndex(graph: SyntheticGraph): SearchablePerson[] {
  return graph.users.map((u) => ({
    didDht: u.did,
    username: u.handle,
    displayName: u.handle,
    channels: u.channels.map((c) => ({
      channelID: c.channelID,
      key: c.channelKey,
      name: c.manifest.name,
    })),
  }))
}

/** What a search SHOULD find, walked out of the graph rather than out of the index.
 *
 *  Independent on purpose: an oracle built from the same projection the implementation
 *  reads would agree with a broken implementation about anything that projection lost. */
function oracle(graph: SyntheticGraph, query: string) {
  const q = query.trim().toLowerCase()
  const people: string[] = []
  const channels: string[] = []
  if (q === '') return { people, channels }
  for (const u of graph.users) {
    if (u.handle.toLowerCase().includes(q)) people.push(u.did)
    for (const c of u.channels) {
      if (c.manifest.name.toLowerCase().includes(q)) channels.push(c.channelID)
    }
  }
  return { people: people.sort(), channels: channels.sort() }
}

function corpus(...people: Partial<SearchablePerson>[]): SearchablePerson[] {
  return people.map((p, i) => ({
    didDht: p.didDht ?? `did:dht:person${i}`,
    username: p.username,
    displayName: p.displayName,
    avatarURL: p.avatarURL,
    channels: p.channels ?? [],
  }))
}

function channel(
  name: string,
  over: { channelID?: string; key?: string } = {},
) {
  return {
    channelID: over.channelID ?? `chan-${name}`,
    key: over.key ?? `K-${name}`,
    name,
  }
}

describe('searching the crawl index', () => {
  it('finds a person by the @-name they chose', () => {
    const hits = searchDirectories('ali', corpus({ username: 'alice' }))
    expect(hits.people.map((p) => p.username)).toEqual(['alice'])
  })

  it('finds a person by their display name', () => {
    const hits = searchDirectories(
      'wonder',
      corpus({ username: 'alice', displayName: 'Alice Wonder' }),
    )
    expect(hits.people.map((p) => p.matched)).toEqual(['displayName'])
  })

  it('finds a channel and hands back the key that opens it', () => {
    // The whole reason a channel hit is worth more than a person hit: an advertised
    // channel publishes its K, so a result is openable rather than merely nameable.
    const hits = searchDirectories(
      'rust',
      corpus({ username: 'bob', channels: [channel('Rust Weekly')] }),
    )
    expect(hits.channels).toEqual([
      {
        didDht: 'did:dht:person0',
        channelID: 'chan-Rust Weekly',
        key: 'K-Rust Weekly',
        name: 'Rust Weekly',
      },
    ])
  })

  it('ignores case in both directions', () => {
    const held = corpus({ username: 'Alice', channels: [channel('CATS')] })
    expect(searchDirectories('alice', held).people).toHaveLength(1)
    expect(searchDirectories('ALICE', held).people).toHaveLength(1)
    expect(searchDirectories('cats', held).channels).toHaveLength(1)
  })

  it('answers an empty query with nothing', () => {
    // A dropdown that listed the entire index the moment the box took focus would be a
    // list of everybody, which is not what anyone typing means.
    const held = corpus({ username: 'alice', channels: [channel('Cats')] })
    expect(searchDirectories('', held)).toEqual({ people: [], channels: [] })
    expect(searchDirectories('   ', held)).toEqual({ people: [], channels: [] })
  })

  it('names somebody once, on whichever half matched', () => {
    // A person whose channel matched is named by the channel already, and listing them in
    // both halves would spend a small dropdown twice on one answer.
    const hits = searchDirectories(
      'cats',
      corpus({ username: 'catslover', channels: [channel('Cats Daily')] }),
    )
    expect(hits.people).toHaveLength(1)
    expect(hits.channels).toHaveLength(1)
  })

  it('puts a chosen @-name ahead of a display name', () => {
    // Provenance, not a score. An @-name is what somebody picked to be found by; a display
    // name is what they wrote about themselves.
    //
    // The names have to sort AGAINST the precedence or the case proves nothing: with
    // `ann` beating `Annabel` alphabetically as well, dropping the precedence leaves the
    // same order and the assertion passes on it.
    const hits = searchDirectories(
      'ann',
      corpus(
        { didDht: 'did:dht:b', displayName: 'Ann Abel' },
        { didDht: 'did:dht:a', username: 'zed-ann' },
      ),
    )
    expect(hits.people.map((p) => p.didDht)).toEqual(['did:dht:a', 'did:dht:b'])
  })

  it('answers the same index the same way twice', () => {
    // Two instances of one identity hold the same records and have to agree, and a
    // dropdown that reordered between keystrokes moves the row out from under the cursor.
    const held = corpus(
      { didDht: 'did:dht:b', username: 'ann' },
      { didDht: 'did:dht:a', username: 'ann' },
    )
    expect(searchDirectories('ann', held).people.map((p) => p.didDht)).toEqual([
      'did:dht:a',
      'did:dht:b',
    ])
  })

  it('caps each half rather than growing the list', () => {
    const many = corpus(
      ...Array.from({ length: MAX_HITS + 5 }, (_, i) => ({
        didDht: `did:dht:p${i}`,
        username: `annie${i}`,
        channels: [channel(`Annals ${i}`, { channelID: `c${i}` })],
      })),
    )
    const hits = searchDirectories('ann', many)
    expect(hits.people).toHaveLength(MAX_HITS)
    expect(hits.channels).toHaveLength(MAX_HITS)
  })

  it('finds nobody a faded record could have named', () => {
    // A faded record dropped its profile and channels, so it reaches the corpus carrying
    // no name at all. Nothing to match is the honest answer; the alternative is a row with
    // a bare did in it.
    expect(
      searchDirectories('any', corpus({ didDht: 'did:dht:faded' })),
    ).toEqual({ people: [], channels: [] })
  })
})

describe('searching the crawl index, against the graph', () => {
  it('finds every person and channel the graph says it should', () => {
    // The coverage claim, checked rather than asserted. `pets` is a channel in the
    // standard fixture and `alice` is a handle, so the set exercises both halves — and
    // `zzz` is what proves a miss is a miss rather than everything.
    for (const query of ['pets', 'alice', 'a', 'zzz']) {
      const hits = searchDirectories(
        query,
        asIndex(STANDARD_GRAPH),
        Number.MAX_SAFE_INTEGER,
      )
      const want = oracle(STANDARD_GRAPH, query)
      expect(hits.people.map((p) => p.didDht).sort()).toEqual(want.people)
      expect(hits.channels.map((c) => c.channelID).sort()).toEqual(
        want.channels,
      )
    }
  })
})

// Tripwire, not a benchmark. The point is to fail loudly if searching the index becomes
// pathologically slow as the crawl holds more of the network — which it is built to do,
// since records fade and are never deleted. One case per scale so each gets its own budget
// and a regression names the size it showed up at.
//
// What is NOT measured here is building the corpus: that is one doc read per held
// identity, which is why it happens once per opening of the box rather than per keystroke.
/** No cap, so a tripwire measures the whole scan rather than the first eight matches. */
const ALL = Number.MAX_SAFE_INTEGER

/** Each scale with a query for each half, because the fixtures name things differently:
 *  the standard graph has real handles and channel names, and the scaled ones are `userN`
 *  and `chN`. One query for both halves would leave one of them unmeasured. */
const SCALES: {
  name: string
  graph: SyntheticGraph
  people: string
  channels: string
}[] = [
  {
    name: 'STANDARD (~5 identities)',
    graph: STANDARD_GRAPH,
    people: 'a',
    channels: 's',
  },
  {
    name: 'MEDIUM (~50 identities)',
    graph: MEDIUM_GRAPH,
    people: 'user',
    channels: 'ch',
  },
  {
    name: 'LARGE (~500 identities)',
    graph: LARGE_GRAPH,
    people: 'user',
    channels: 'ch',
  },
  {
    name: 'HUGE (~10K identities)',
    graph: HUGE_GRAPH,
    people: 'user',
    channels: 'ch',
  },
]

describe('index search performance (tripwire)', () => {
  it.each(SCALES)('$name answers within 2 seconds', (scale) => {
    const held = asIndex(scale.graph)
    const queries = [scale.people, scale.channels]

    const start = performance.now()
    const found = queries.map((q) => searchDirectories(q, held, ALL))
    const elapsedMs = performance.now() - start

    // A perf check that does not also assert the right answer is a perf check silently
    // passing on broken code — and an equality between two EMPTY lists is that check with
    // its assertion still in place, which is how three of these scales passed while timing
    // a query that matched nothing at all.
    queries.forEach((query, i) => {
      const want = oracle(scale.graph, query)
      expect(want.people.length + want.channels.length).toBeGreaterThan(0)
      expect(found[i]?.people.map((p) => p.didDht).sort()).toEqual(want.people)
      expect(found[i]?.channels.map((c) => c.channelID).sort()).toEqual(
        want.channels,
      )
    })

    expect(elapsedMs).toBeLessThan(2000)
  })
})
