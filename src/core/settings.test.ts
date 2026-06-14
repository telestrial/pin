import { describe, expect, it } from 'vitest'
import { staleSettingsIds } from './settings'

const C = (id: string, updatedAt: string) => ({ id, updatedAt })

describe('staleSettingsIds', () => {
  it('marks strictly-older settings objects stale', () => {
    const cands = [
      C('new', '2026-06-14T03:00:00.000Z'),
      C('old', '2026-06-14T01:00:00.000Z'),
      C('older', '2026-06-13T00:00:00.000Z'),
    ]
    expect(
      staleSettingsIds(cands, 'new', '2026-06-14T03:00:00.000Z').sort(),
    ).toEqual(['old', 'older'])
  })

  it('never marks the kept object itself', () => {
    expect(
      staleSettingsIds([C('a', 't2'), C('b', 't1')], 'a', 't2'),
    ).toEqual(['b'])
    expect(staleSettingsIds([C('a', 't2')], 'a', 't2')).toEqual([])
  })

  it('protects equal-updatedAt duplicates (never deleted)', () => {
    const t = '2026-06-14T03:00:00.000Z'
    expect(staleSettingsIds([C('a', t), C('b', t)], 'a', t)).toEqual([])
  })

  it('protects a NEWER object when we fell back to an older readable one', () => {
    // 'a' is newer but its body was unreadable, so we kept older 'b'. 'a' must
    // NOT be deleted — it's the real latest, just transiently unreadable.
    const cands = [
      C('a', '2026-06-14T05:00:00.000Z'),
      C('b', '2026-06-14T02:00:00.000Z'),
    ]
    expect(staleSettingsIds(cands, 'b', '2026-06-14T02:00:00.000Z')).toEqual([])
  })

  it('returns nothing for an empty candidate set', () => {
    expect(staleSettingsIds([], 'x', 't')).toEqual([])
  })
})
