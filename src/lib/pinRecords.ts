// What this identity keeps, as records in the doc.
//
// The pin list used to live only in localStorage, which quietly made it device-local
// in two ways that matter. It didn't travel — pin something on a laptop and a phone
// never heard about it — and losing that browser's storage stranded the bytes: they
// stay pinned in the Sia scope with nothing left referencing them, and the orphan
// sweep was removed on the positive-id principle, so nothing reclaims them. A pin
// isn't a cache. It's the record of what you decided to keep.
//
// It's also what the Curator needs before it can repack: repack rewrites REFERENCES,
// so it has to know what points at what, and Sia can say which objects are pinned but
// not that this one is the body of a post you kept from someone's channel.
//
// One record per pin, not one list. A pin carries the item's whole ItemRef (a text
// item's body included), so a list would be a large blob rewritten on every pin. And
// per-pin records merge by UNION across devices — pin on a laptop and on a phone and
// both survive, where one list record would be last-writer-wins and drop one of them.
//
// Sealed under its own AppKey-derived key: a pin names its Sia object by share URL,
// and a share URL's fragment IS that object's decryption key.

import {
  pinned_collection,
  pinned_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
import {
  decryptForChannel,
  derivePinnedKey,
  encryptForChannel,
} from '../core/crypto'
import { ensureWasm } from '../core/wasm'
import type { PinnedItemRef } from '../stores/pin'
import {
  deleteRecord,
  getRecord,
  listRecords,
  openDocs,
  putRecord,
} from './docs'

/** The rkey for one pin. From Rust: the Curator's repack reads these records, so the
 *  spelling can't be spelled twice. */
export async function pinRkey(ref: PinnedItemRef): Promise<string> {
  await ensureWasm()
  return pinned_rkey(ref.channel.channelID, ref.item.publishedAt)
}

export async function collection(): Promise<string> {
  await ensureWasm()
  return pinned_collection()
}

async function key(appKeyHex: string): Promise<Uint8Array> {
  return derivePinnedKey(Uint8Array.fromHex(appKeyHex))
}

/** Record one pin, at the moment it is made.
 *
 *  A pin is a decision, so it is written where the decision is taken rather than
 *  inferred later by something watching the local list change. That is what lets the
 *  release below be exact: the action that unpinned knows what it unpinned, where a
 *  reconciler could only see an absence — and absence cannot mean deletion when two
 *  devices share this doc.
 *
 *  A drift swap rewrites the SAME record: the rkey is `(channelID, publishedAt)`, which
 *  an edit preserves, so updating a pin to the author's current version overwrites
 *  rather than orphaning.
 *
 *  Skips the write when the record already says this, so re-pinning something unchanged
 *  doesn't churn the doc or wake every instance syncing it. */
export async function writePinRecord(
  appKeyHex: string,
  ref: PinnedItemRef,
): Promise<void> {
  await openDocs(appKeyHex)
  const coll = await collection()
  const k = await key(appKeyHex)
  const rkey = await pinRkey(ref)
  const serialized = JSON.stringify(ref)
  const existing = await getRecord(coll, rkey)
  if (existing) {
    try {
      if ((await decryptForChannel(k, decode(existing))) === serialized) return
    } catch {
      // Unreadable — rewrite it rather than leave a record we can't verify.
    }
  }
  const sealed = await encryptForChannel(k, serialized)
  await putRecord(coll, rkey, new TextEncoder().encode(sealed))
}

/** Releases whose record didn't come off, by rkey.
 *
 *  Held here because this is where the knowledge exists. A release is the one thing a
 *  reconciler can never work out for itself: two devices share this doc, so a record the
 *  local list doesn't mention might be a pin the other device just made. Only the action
 *  that unpinned knows, so a failed delete is remembered rather than re-derived. */
const pendingReleases = new Set<string>()

/** Release one pin's record, remembering it if that fails. */
export async function deletePinRecord(
  appKeyHex: string,
  ref: PinnedItemRef,
): Promise<void> {
  const rkey = await pinRkey(ref)
  try {
    await openDocs(appKeyHex)
    await deleteRecord(await collection(), rkey)
  } catch (e) {
    pendingReleases.add(rkey)
    throw e
  }
}

/** Retry the releases that didn't land. Clears each on success; a still-failing one
 *  stays for the next attempt, because a record that outlives its pin gets adopted
 *  straight back by the read side. */
export async function drainPendingReleases(appKeyHex: string): Promise<number> {
  if (pendingReleases.size === 0) return 0
  await openDocs(appKeyHex)
  const coll = await collection()
  let released = 0
  for (const rkey of [...pendingReleases]) {
    try {
      await deleteRecord(coll, rkey)
      pendingReleases.delete(rkey)
      released++
    } catch {
      // Stays pending.
    }
  }
  return released
}

/** Catch up: record every pin held locally that the doc doesn't already say.
 *
 *  ADDITIVE ONLY, and it has no release argument at all — a record the local list
 *  doesn't mention is left alone. That is the whole safety property, because two devices
 *  share this doc: if absence meant deletion, the first device to run this would erase
 *  every pin the second had just made, purely for not having heard about them yet.
 *  Deletion by absence is the mistake this codebase has already made twice (the orphan
 *  sweep, and settings).
 *
 *  Releases therefore don't come through here. They're done by the unpin that made them,
 *  and retried from what that left behind (see `drainPendingReleases`) — because only
 *  the action that released a pin can tell a release from a stranger's new pin.
 *
 *  Returns what it did, so a caller can decide whether anything downstream (the Sia
 *  snapshot) needs to run. Throws only on a failure that leaves the doc unreconciled;
 *  the caller retries on the next change. */
export async function syncPinRecords(
  appKeyHex: string,
  pinned: readonly PinnedItemRef[],
): Promise<{ written: number }> {
  await openDocs(appKeyHex)
  const coll = await collection()
  const k = await key(appKeyHex)
  let written = 0

  for (const ref of pinned) {
    const rkey = await pinRkey(ref)
    // Compare before writing: a pin's record is rewritten only when its content
    // actually moved (repack swapping an itemURL, a drift swap), so an unchanged
    // pin doesn't churn the doc — and doesn't announce a change to every instance
    // syncing it — on every reconcile.
    const serialized = JSON.stringify(ref)
    const existing = await getRecord(coll, rkey)
    if (existing) {
      try {
        if ((await decryptForChannel(k, decode(existing))) === serialized) {
          continue
        }
      } catch {
        // Unreadable — rewrite it rather than leave a record we can't verify.
      }
    }
    const sealed = await encryptForChannel(k, serialized)
    await putRecord(coll, rkey, new TextEncoder().encode(sealed))
    written++
  }

  return { written }
}

/** Every pin recorded in the doc. Skips records that won't open rather than failing
 *  the read: one unreadable pin must not cost you the rest of your library. */
export async function readPinRecords(
  appKeyHex: string,
): Promise<PinnedItemRef[]> {
  await openDocs(appKeyHex)
  const coll = await collection()
  const k = await key(appKeyHex)
  const out: PinnedItemRef[] = []
  for (const rkey of await listRecords(coll)) {
    const sealed = await getRecord(coll, rkey)
    if (!sealed) continue
    try {
      out.push(JSON.parse(await decryptForChannel(k, decode(sealed))))
    } catch {
      // Skip.
    }
  }
  return out
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
