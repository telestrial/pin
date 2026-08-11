// The endorsements this identity has made, as records in the doc.
//
// One signed record per endorsement, which the Curator's identity loop folds into the
// public directory. So this file writes; publishing is somebody else's job, and reading
// somebody ELSE's endorsements is the crawl's.
//
// PLAINTEXT, unlike a pin record. A pin is private — its record names a Sia object by
// share URL, and a share URL's fragment is that object's decryption key — where an
// endorsement exists in order to be published. Sealing something on its way to a public
// blob would protect nothing and cost the fold a decrypt. The same reasoning makes
// instance registrations plaintext.
//
// What keeps that safe at every visibility tier is that the subject is a HASH: a record
// for an unlisted channel carries no reference, so it is a countable token that reveals
// neither which channel it concerns nor that the channel exists. Only a holder of K can
// compute the subject and match it.
//
// Written where the deciding is, in the same shape as a pin record and for the same
// reason: an action knows exactly what it did, where something watching a list change
// afterwards has to work it out, and can never tell an absence from an endorsement
// another device made that hasn't arrived yet.

import {
  endorse_collection,
  endorse_rkey,
  sign_endorsement,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import {
  deleteRecord,
  getRecord,
  listRecords,
  openDocs,
  putRecord,
} from './docs'

/** The gestures that produce an endorsement.
 *
 *  Open on the wire — a reader folds the kinds it understands and ignores the rest — but
 *  a closed union here, because these are the ones this app can currently make. */
export type EndorsementKind = 'like' | 'pin'

/** What an endorsement is about, from the caller's side. `contentHash` is the version it
 *  is made against; the subject itself survives an edit, so this is what records that the
 *  wording has moved since. */
export type EndorsedItem = {
  channelID: string
  publishedAt: string
  contentHash?: string
  // Set to endorse one ATTACHMENT of that post rather than the post, named by its content
  // hash. Its count is separate on purpose: keeping a file alive is not keeping the post
  // alive, so a partial custodian must not be counted as a full one.
  attachment?: string
}

/** Who to name as the channel's author in the record's reference, or null for none.
 *
 *  Null is the SAFE value and the one to pass when unsure: it publishes the subject hash
 *  alone. A did:dht here makes the record navigable, which is only correct when the
 *  channel is public — for an unlisted one it would give away both the channel and its
 *  existence, which is the property being protected. */
export type ReferenceAuthor = string | null

export async function collection(): Promise<string> {
  await ensureWasm()
  return endorse_collection()
}

/** Where one endorsement lives. From Rust: the Curator's fold reads these records back,
 *  so the address can't be spelled twice. */
export async function endorsementRkey(
  kind: EndorsementKind,
  item: EndorsedItem,
): Promise<string> {
  await ensureWasm()
  return endorse_rkey(kind, item.channelID, item.publishedAt, item.attachment)
}

/** Sign and store one endorsement.
 *
 *  Skips the write when the record already says exactly this, so re-making a gesture
 *  doesn't churn the doc or wake every instance syncing it. The comparison can't be on
 *  the whole record — a fresh signature over a fresh `createdAt` differs every time — so
 *  it is on the parts that carry meaning. An existing record therefore keeps its original
 *  timestamp, which is right: the endorsement was made when it was made.
 *
 *  A reference can be ADDED to an existing record without re-signing, because it sits
 *  outside the signature. That is what lets a catch-up upgrade a record it first wrote
 *  before the channel's manifest had loaded. */
export async function writeEndorsement(
  appKeyHex: string,
  kind: EndorsementKind,
  item: EndorsedItem,
  referenceAuthor: ReferenceAuthor,
  now = new Date().toISOString(),
): Promise<boolean> {
  await ensureWasm()
  await openDocs(appKeyHex)
  const coll = await collection()
  const rkey = await endorsementRkey(kind, item)

  const existing = await getRecord(coll, rkey)
  if (existing && !differs(existing, item, referenceAuthor)) return false

  const record = sign_endorsement(
    appKeyHex,
    kind,
    item.channelID,
    item.publishedAt,
    item.contentHash ?? '',
    referenceAuthor ?? undefined,
    item.attachment,
    now,
  )
  await putRecord(coll, rkey, new TextEncoder().encode(record))
  return true
}

/** Whether a stored record disagrees with what we would write now.
 *
 *  Unreadable counts as different: better to rewrite a record we can't verify than to
 *  leave one we can't account for in a count. */
function differs(
  stored: Uint8Array,
  item: EndorsedItem,
  referenceAuthor: ReferenceAuthor,
): boolean {
  try {
    const held = JSON.parse(new TextDecoder().decode(stored))
    if (held.version !== (item.contentHash ?? '')) return true
    if ((held.ref?.didDht ?? null) !== referenceAuthor) return true
    // Only meaningful when there IS a reference to compare. Checking it unconditionally
    // would report a difference forever for a hash-only attachment endorsement — no ref
    // to carry the field, an attachment to compare it against — and every catch-up would
    // rewrite the record and wake every instance syncing the doc.
    if (referenceAuthor !== null) {
      return (held.ref?.attachment ?? undefined) !== item.attachment
    }
    return false
  } catch {
    return true
  }
}

/** Releases whose record didn't come off, by rkey.
 *
 *  Held rather than re-derived for the reason a pin's release is: two devices share this
 *  doc, so a record the local state doesn't mention might be an endorsement the other
 *  one just made. Only the action that withdrew knows — and a leftover record is an
 *  over-count that nothing else would ever correct. */
const pendingReleases = new Set<string>()

/** Withdraw one endorsement, remembering it if that fails. */
export async function deleteEndorsement(
  appKeyHex: string,
  kind: EndorsementKind,
  item: EndorsedItem,
): Promise<void> {
  const rkey = await endorsementRkey(kind, item)
  try {
    await openDocs(appKeyHex)
    await deleteRecord(await collection(), rkey)
    pendingReleases.delete(rkey)
  } catch (e) {
    pendingReleases.add(rkey)
    throw e
  }
}

/** Retry the withdrawals that didn't land. A still-failing one stays pending, because
 *  a record that outlives its gesture keeps being counted. */
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

/** Catch up: record every endorsement that should exist and doesn't yet.
 *
 *  ADDITIVE ONLY, and deliberately takes no releases. A record this pass doesn't
 *  recognize is left alone, because from here an absence is unreadable — the same safety
 *  property `syncPinRecords` has, and for the same reason: if absence meant deletion, the
 *  first device to run this would erase what the second had just done, purely for not
 *  having heard about it. Deletion by absence is the mistake this codebase has already
 *  made twice, in the orphan sweep and in settings. */
export async function syncEndorsements(
  appKeyHex: string,
  wanted: readonly {
    kind: EndorsementKind
    item: EndorsedItem
    referenceAuthor: ReferenceAuthor
  }[],
): Promise<{ written: number }> {
  let written = 0
  for (const w of wanted) {
    if (await writeEndorsement(appKeyHex, w.kind, w.item, w.referenceAuthor)) {
      written++
    }
  }
  return { written }
}

/** The rkeys of every endorsement recorded in the doc, so a caller can tell what this
 *  identity has already asserted without opening each record. */
export async function listEndorsementRkeys(
  appKeyHex: string,
): Promise<string[]> {
  await openDocs(appKeyHex)
  return listRecords(await collection())
}
