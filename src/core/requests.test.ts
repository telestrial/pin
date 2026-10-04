import { describe, expect, it } from 'vitest'
import {
  type InboxRequest,
  pendingRequests,
  type RequestDecision,
} from './requests'

const CH = 'chan'
const req = (
  actor: string,
  createdAt: string,
  extra: Partial<InboxRequest> = {},
): InboxRequest => ({ channelID: CH, actor, createdAt, ...extra })

const none = new Map<string, RequestDecision>()
const empty = new Set<string>()
const actors = (rs: InboxRequest[]) => rs.map((r) => r.actor)

describe('pendingRequests', () => {
  it('keeps standing requests for the channel and drops the rest', () => {
    const got = pendingRequests(
      CH,
      [
        req('a', 't1'),
        req('b', 't2', { withdrawn: true }),
        req('c', 't3', { channelID: 'other' }),
      ],
      none,
      empty,
      empty,
    )
    expect(actors(got)).toEqual(['a'])
  })

  it('drops one answered, and waits again on a newer request after it', () => {
    const decisions = new Map<string, RequestDecision>([
      ['a', { decision: 'denied', requestCreatedAt: 't1' }],
      ['b', { decision: 'denied', requestCreatedAt: 't1' }],
    ])
    const got = pendingRequests(
      CH,
      [req('a', 't1'), req('b', 't5')],
      decisions,
      empty,
      empty,
    )
    expect(actors(got)).toEqual(['b'])
  })

  it('drops somebody already a member', () => {
    expect(
      pendingRequests(CH, [req('a', 't1')], none, new Set(['a']), empty),
    ).toEqual([])
  })

  it('puts people in the graph first, then the oldest', () => {
    const got = pendingRequests(
      CH,
      [req('a', 't3'), req('b', 't1'), req('c', 't2'), req('d', 't4')],
      none,
      empty,
      new Set(['d', 'c']),
    )
    expect(actors(got)).toEqual(['c', 'd', 'b', 'a'])
  })
})
