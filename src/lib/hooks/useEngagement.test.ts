import { describe, expect, it } from 'vitest'
import { showsUncounted, showsWithdrawn } from './useEngagement'

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

// The mirror, and the weaker claim: a count is only dropped where the author's own
// published sample proves it counted us.
describe('showsWithdrawn', () => {
  const ME = 'did:dht:me'
  const HELD = '2026-08-17T12:00:00.000Z'

  it('drops a gesture the published sample still names us in', () => {
    // The whole point: taking back a like the author had already folded used to leave
    // their count one high with nothing on this side able to say so.
    expect(showsWithdrawn(ME, null, [ME, 'did:dht:someone'])).toBe(true)
  })

  it('drops nothing while the record is still held', () => {
    // Named in the sample AND still holding it is the ordinary counted state — the count
    // is right, and subtracting would make it one low.
    expect(showsWithdrawn(ME, HELD, [ME])).toBe(false)
  })

  it('drops nothing when the sample cannot say whether we were counted', () => {
    // Above five actors we are not in the sample, so being absent from it is not evidence
    // of anything. The row shows one high until the author folds again, which is what it
    // did before this existed — never a count lower than the truth.
    expect(showsWithdrawn(ME, null, ['did:dht:a', 'did:dht:b'])).toBe(false)
    expect(showsWithdrawn(ME, null, [])).toBe(false)
    expect(showsWithdrawn(ME, null, undefined)).toBe(false)
  })

  it('drops nothing before this identity is known', () => {
    // Membership is a question about our own DID, and it resolves a moment after boot.
    expect(showsWithdrawn(null, null, [ME])).toBe(false)
  })

  it('never applies at the same time as showsUncounted', () => {
    // One needs a record held and the other needs none, so the two adjustments cannot
    // both fire — which is what keeps a single count from being nudged twice.
    for (const heldAt of [null, HELD]) {
      const added = showsUncounted(heldAt, undefined)
      const removed = showsWithdrawn(ME, heldAt, [ME])
      expect(added && removed).toBe(false)
    }
  })
})
