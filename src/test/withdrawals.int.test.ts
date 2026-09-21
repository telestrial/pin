// The withdrawal ledger settling against the doc.
//
// A withdrawal is a deletion, so the only thing that records it is the record's absence
// — and an absence can be undone. The ledger remembers what was taken back until the
// thing that makes a deletion durable has caught up, which is a different artifact on
// each platform: a redb store the desktop keeps across restarts, and on web a snapshot
// taken seconds later, with a fresh MemStore in between.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The doc is keyed by the PAIR rather than by a joined string. Joining it back with the
// same separator the ledger split on makes every split look correct — a lastIndexOf
// sabotage passed against a map keyed that way, because both halves re-joined to one key.
const { doc, deleted } = vi.hoisted(() => ({
  doc: [] as { collection: string; rkey: string }[],
  deleted: [] as { collection: string; rkey: string }[],
}))

const holds = (collection: string, rkey: string) =>
  doc.some((e) => e.collection === collection && e.rkey === rkey)

vi.mock('../lib/docs', () => ({
  getRecord: async (collection: string, rkey: string) =>
    doc.some((e) => e.collection === collection && e.rkey === rkey)
      ? new Uint8Array([1])
      : undefined,
  deleteRecord: async (collection: string, rkey: string) => {
    deleted.push({ collection, rkey })
    const at = doc.findIndex(
      (e) => e.collection === collection && e.rkey === rkey,
    )
    if (at >= 0) doc.splice(at, 1)
  },
}))

import {
  addressOf,
  rememberWithdrawn,
  settleWithdrawals,
  withdrawnAddresses,
} from '../lib/withdrawn'

const LIKE = addressOf('endorse', 'like:subject-one')

/** A tab has a MemStore; the desktop has redb. `inTauri` reads this. */
function runningOnDesktop(yes: boolean) {
  if (yes) {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

describe('integration: settling the withdrawal ledger', () => {
  beforeEach(() => {
    localStorage.clear()
    doc.length = 0
    deleted.length = 0
    runningOnDesktop(false)
  })

  afterEach(() => {
    runningOnDesktop(false)
  })

  it('retries a deletion the doc shows never landed', async () => {
    doc.push({ collection: 'endorse', rkey: 'like:subject-one' })
    rememberWithdrawn('endorse', 'like:subject-one')

    expect(await settleWithdrawals()).toBe(1)
    expect(holds('endorse', 'like:subject-one')).toBe(false)
    // Kept: the record has only just left the doc, and on web nothing durable has
    // caught up with that yet.
    expect(withdrawnAddresses()).toContain(LIKE)
  })

  it('forgets an address the doc is rid of when the doc is the durable store', async () => {
    runningOnDesktop(true)
    rememberWithdrawn('endorse', 'like:subject-one')

    expect(await settleWithdrawals()).toBe(0)
    expect(withdrawnAddresses()).not.toContain(LIKE)
  })

  it('keeps an address the doc is rid of when the doc is a MemStore', async () => {
    // The snapshot may still carry it, and only the restore can see that. Forgetting
    // here drops the entry a moment before the next restore puts the record back.
    rememberWithdrawn('endorse', 'like:subject-one')

    expect(await settleWithdrawals()).toBe(0)
    expect(withdrawnAddresses()).toContain(LIKE)
  })

  it('splits an address on the first separator', async () => {
    // A collection name carries no slash; an rkey does — `{subject}:{id}:{actor}` for a
    // held comment, and a repost portal's address is a triple.
    doc.push({ collection: 'comment', rkey: 'subject-one:abc/def' })
    rememberWithdrawn('comment', 'subject-one:abc/def')

    expect(await settleWithdrawals()).toBe(1)
    // The pair, so a split at the last separator is a different collection and a
    // different rkey instead of the same joined string.
    expect(deleted).toEqual([
      { collection: 'comment', rkey: 'subject-one:abc/def' },
    ])
  })
})
