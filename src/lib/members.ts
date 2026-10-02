// Who is in this identity's members-only channels, and which channels it is a member of.
//
// The Curator keeps both in the doc: a roster of seatings per channel the author owns, and
// a membership per channel this identity was invited to. Reading them is a doc read like
// any other, on either platform. Writing a seating is not — inviting seals an invitation
// to the person and picks their leaf in the channel's member tree — so invite and remove
// go to Rust, natively on desktop where the doc lives, in the tab's engine on web.

import {
  members_collection,
  members_invite,
  members_remove,
  membership_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import { getRecord, listRecords } from './docs'
import { inTauri } from './openExternal'

/** One seating of one member, as the roster holds it. */
export type Seat = {
  id: string
  did: string
  encKey: string
  leaf: number
  addedAt: string
  removedAt?: string
}

/** One channel this identity was invited to: what climbing to its key needs. */
export type Membership = {
  channelKey: string
  author: string
  authorEncKey: string
  leaf: number
  seatId: string
}

/** Seat a person in one of this identity's members-only channels, and seal their
 *  invitation. `encKey` is the encryption key their directory publishes. A person already
 *  in is answered with the seating they have. */
export async function inviteMember(
  appKeyHex: string,
  channelKey: Uint8Array,
  did: string,
  encKey: string,
): Promise<Seat> {
  const nowIso = new Date().toISOString()
  if (inTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<Seat>('members_invite', {
      appKeyHex,
      channelKey: Array.from(channelKey),
      did,
      encKeyB64: encKey,
      nowIso,
    })
  }
  await ensureWasm()
  return JSON.parse(
    await members_invite(appKeyHex, channelKey, did, encKey, nowIso),
  ) as Seat
}

/** Take a person out of one of this identity's members-only channels. Answers with how
 *  many of their seatings were standing, which is zero when they were not in. */
export async function removeMember(
  channelID: string,
  did: string,
): Promise<number> {
  const nowIso = new Date().toISOString()
  if (inTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<number>('members_remove', {
      channelId: channelID,
      did,
      nowIso,
    })
  }
  await ensureWasm()
  return members_remove(channelID, did, nowIso)
}

/** Every seating of one channel's roster, removed ones included. A record that will not
 *  parse is left out: this is a list for a screen, and the Curator is the one that has
 *  to refuse a partial roster. */
export async function readRoster(channelID: string): Promise<Seat[]> {
  await ensureWasm()
  const collection = members_collection()
  const prefix = `${channelID}:`
  const seats: Seat[] = []
  for (const rkey of await listRecords(collection)) {
    if (!rkey.startsWith(prefix)) continue
    const seat = parse<Seat>(await getRecord(collection, rkey))
    if (seat) seats.push(seat)
  }
  return seats
}

/** The members a roster currently seats: one per person, removed seatings left out. */
export function standingMembers(seats: Seat[]): Seat[] {
  const byDid = new Map<string, Seat>()
  for (const seat of seats) {
    if (seat.removedAt) continue
    if (!byDid.has(seat.did)) byDid.set(seat.did, seat)
  }
  return [...byDid.values()]
}

/** Every channel this identity holds a membership in, by channelID. */
export async function readMemberships(): Promise<
  { channelID: string; membership: Membership }[]
> {
  await ensureWasm()
  const collection = membership_collection()
  const out: { channelID: string; membership: Membership }[] = []
  for (const channelID of await listRecords(collection)) {
    const membership = parse<Membership>(await getRecord(collection, channelID))
    if (membership) out.push({ channelID, membership })
  }
  return out
}

function parse<T>(bytes: Uint8Array | undefined): T | null {
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    return null
  }
}
