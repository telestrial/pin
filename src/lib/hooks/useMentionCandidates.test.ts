import { describe, expect, it } from 'vitest'
import type { ReachablePerson } from '../../core/network'
import { filterMentionCandidates } from './useMentionCandidates'

const person = (
  handle: string,
  username?: string,
  distance = 0,
): ReachablePerson => ({ did: `did:${handle}`, handle, username, distance })

describe('filterMentionCandidates', () => {
  const pool = [
    person('alice.bsky.social', 'alice'),
    person('bob.example.com'),
    person('carol.bsky.social', 'coolcarol', 1),
  ]

  it('returns the whole pool for an empty query, capped by limit', () => {
    expect(filterMentionCandidates(pool, '')).toHaveLength(3)
    expect(filterMentionCandidates(pool, '', 2)).toHaveLength(2)
  })

  it('matches on username', () => {
    expect(filterMentionCandidates(pool, 'cool').map((c) => c.did)).toEqual([
      'did:carol.bsky.social',
    ])
  })

  it('matches on handle when there is no username', () => {
    expect(filterMentionCandidates(pool, 'bob').map((c) => c.did)).toEqual([
      'did:bob.example.com',
    ])
  })

  it('is case-insensitive and trims', () => {
    expect(filterMentionCandidates(pool, '  ALICE ')).toHaveLength(1)
  })
})
