import { describe, expect, it } from 'vitest'
import {
  mergeDirectory,
  parseDirectory,
  pickPeers,
  type RzEntry,
} from './rendezvous'

const NOW = 1_000_000
const TTL = 900 // 15 min

const entry = (id: string, ageSec: number, durable = false): RzEntry => ({
  id,
  at: NOW - ageSec,
  durable,
})

describe('mergeDirectory', () => {
  it('adds my entry to an empty directory', () => {
    const mine = entry('me', 0)
    expect(mergeDirectory([], mine, NOW, TTL)).toEqual([mine])
  })

  it('replaces my own prior entry (matched by id), never duplicating me', () => {
    const old = entry('me', 300)
    const fresh = entry('me', 0)
    const out = mergeDirectory([old, entry('other', 60)], fresh, NOW, TTL)
    expect(out.filter((e) => e.id === 'me')).toEqual([fresh])
    expect(out.map((e) => e.id).sort()).toEqual(['me', 'other'])
  })

  it('drops entries older than the TTL', () => {
    const stale = entry('dead', TTL + 1)
    const live = entry('live', 60)
    const mine = entry('me', 0)
    const out = mergeDirectory([stale, live], mine, NOW, TTL)
    expect(out.map((e) => e.id).sort()).toEqual(['live', 'me'])
  })

  it('drops malformed entries', () => {
    const junk = [{ id: 'x' }, null, 42] as unknown as RzEntry[]
    const mine = entry('me', 0)
    expect(mergeDirectory(junk, mine, NOW, TTL)).toEqual([mine])
  })
})

describe('pickPeers', () => {
  it('excludes me and stale entries', () => {
    const dir = [entry('me', 0), entry('peer', 60), entry('dead', TTL + 1)]
    expect(pickPeers(dir, 'me', NOW, TTL).map((e) => e.id)).toEqual(['peer'])
  })

  it('prefers durable, then most-recent', () => {
    const dir = [
      entry('web-old', 200),
      entry('web-new', 10),
      entry('desktop', 100, true),
    ]
    // desktop (durable) first, then web-new before web-old by recency.
    expect(pickPeers(dir, 'me', NOW, TTL).map((e) => e.id)).toEqual([
      'desktop',
      'web-new',
      'web-old',
    ])
  })

  it('returns [] when only my own entry is present', () => {
    expect(pickPeers([entry('me', 0)], 'me', NOW, TTL)).toEqual([])
  })
})

describe('parseDirectory', () => {
  it('parses the {v, instances} shape', () => {
    const dir = { v: 1, instances: [entry('a', 0), entry('b', 60, true)] }
    expect(parseDirectory(JSON.stringify(dir))).toEqual(dir.instances)
  })

  it('parses a bare array', () => {
    const arr = [entry('a', 0)]
    expect(parseDirectory(JSON.stringify(arr))).toEqual(arr)
  })

  it('returns [] on empty / malformed / non-entry payloads', () => {
    expect(parseDirectory('')).toEqual([])
    expect(parseDirectory('not json')).toEqual([])
    expect(parseDirectory('{"v":1}')).toEqual([])
    expect(parseDirectory('{"v":1,"instances":[{"id":"x"}]}')).toEqual([])
  })
})
