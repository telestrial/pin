import { describe, expect, it } from 'vitest'
import { autoWatchAdditions, autoWatchRemovals } from './handleFollow'
import type { SubscriptionRef } from './types'

function sub(channelID: string): SubscriptionRef {
  return {
    authorHandle: 'someone.bsky.social',
    authorDID: 'did:plc:someone0000000000000000',
    channelID,
    channelKey: 'AAAA',
    addedAt: '2026-06-15T00:00:00.000Z',
  }
}

describe('autoWatchAdditions', () => {
  it('adds claimed channels not already subscribed', () => {
    const adds = autoWatchAdditions(
      [sub('aaaa'), sub('bbbb')],
      new Set<string>(),
      new Set<string>(),
    )
    expect(adds.map((s) => s.channelID)).toEqual(['aaaa', 'bbbb'])
  })

  it('skips channels already subscribed', () => {
    const adds = autoWatchAdditions(
      [sub('aaaa'), sub('bbbb')],
      new Set(['aaaa']),
      new Set<string>(),
    )
    expect(adds.map((s) => s.channelID)).toEqual(['bbbb'])
  })

  it('skips tombstoned channels — an explicit unsubscribe sticks', () => {
    const adds = autoWatchAdditions(
      [sub('aaaa'), sub('bbbb')],
      new Set<string>(),
      new Set(['bbbb']),
    )
    expect(adds.map((s) => s.channelID)).toEqual(['aaaa'])
  })

  it('dedups a channel reached via two followed people', () => {
    const adds = autoWatchAdditions(
      [sub('aaaa'), sub('aaaa')],
      new Set<string>(),
      new Set<string>(),
    )
    expect(adds.map((s) => s.channelID)).toEqual(['aaaa'])
  })
})

describe('autoWatchRemovals', () => {
  it('removes only their claimed channels we currently hold', () => {
    const removals = autoWatchRemovals(
      ['aaaa', 'bbbb', 'cccc'],
      new Set(['aaaa', 'cccc']),
    )
    expect(removals).toEqual(['aaaa', 'cccc'])
  })

  it('returns nothing when none of their channels are held', () => {
    const removals = autoWatchRemovals(['aaaa'], new Set(['zzzz']))
    expect(removals).toEqual([])
  })

  it('dedups repeated claimed channelIDs', () => {
    const removals = autoWatchRemovals(['aaaa', 'aaaa'], new Set(['aaaa']))
    expect(removals).toEqual(['aaaa'])
  })
})
