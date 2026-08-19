import { describe, expect, it } from 'vitest'
import { showsUncounted } from './useEngagement'

// The rule that lets a row add this identity's own gesture to somebody else's published
// count without ever being wrong about it. Pure, so it is tested here rather than through
// a render: what matters is which side of the author's fold a record falls on.
describe('showsUncounted', () => {
  const FOLD = '2026-08-17T12:00:00.000Z'

  it('adds a record the fold cannot have seen', () => {
    // A fold stamped at T contains only records written before T, so one stamped after it
    // is provably missing from that count.
    expect(showsUncounted('2026-08-17T12:00:01.000Z', FOLD)).toBe(true)
  })

  it('stops adding once a fold that includes it arrives', () => {
    // This is what makes it self-correcting rather than optimistic: the +1 goes away on
    // its own, so the count can never end up one high forever.
    expect(showsUncounted('2026-08-17T11:59:59.000Z', FOLD)).toBe(false)
    // Equal counts as seen. A fold stamped at the same instant is the likelier reading,
    // and erring this way shows a count one LOW for a moment rather than one high — the
    // direction that can't overstate what a backing set holds.
    expect(showsUncounted(FOLD, FOLD)).toBe(false)
  })

  it('adds nothing when this identity holds no record', () => {
    expect(showsUncounted(null, FOLD)).toBe(false)
    expect(showsUncounted(null, undefined)).toBe(false)
  })

  it('adds a held record when no count exists yet', () => {
    // Nothing has counted it, so it is uncounted in the most literal sense. This is the
    // ordinary case for the first gesture on a post.
    expect(showsUncounted('2026-08-17T12:00:00.000Z', undefined)).toBe(true)
  })

  it('adds nothing for a held record with no time on it', () => {
    // A record that parsed but carries no `createdAt` reads as held-but-untimed. It
    // cannot be shown to postdate the fold, so it isn't added — the same direction every
    // other unknown here errs in.
    expect(showsUncounted('', FOLD)).toBe(false)
  })
})
