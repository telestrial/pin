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
  endorse_comment_rkey,
  endorse_rkey,
  sign_comment_endorsement,
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
 *  a closed union here, because these are the ones this app can currently make.
 *
 *  All three are ACTOR-keyed, which is what each count means. A repost is one endorsement
 *  however many of your channels carry the post: the number is reposters rather than
 *  reposts, the same way a like is likers. Which of your own channels carry it is a
 *  different question, and one only you can answer. */
export type EndorsementKind = 'like' | 'pin' | 'repost'

/** What an endorsement is about, from the caller's side. `contentHash` is the version it
 *  is made against; the subject itself survives an edit, so this is what records that the
 *  wording has moved since. */
export type EndorsedItem = {
  channelID: string
  publishedAt: string
  contentHash?: string
  // Set to endorse a COMMENT on that post rather than the post. A comment's subject is
  // derived from who wrote it and when, not from the post's coordinates — so this replaces
  // the derivation instead of narrowing it, which is why it carries the pair it needs.
  //
  // channelID stays because it is what the CACHE is keyed by: a comment's counts sit beside
  // its post's in the same channel's doc.
  comment?: { actor: string; createdAt: string }
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

/** Who to name in an endorsement's reference for a given channel.
 *
 *  Read from the manifest this identity already holds. A did:dht only for a PUBLIC
 *  channel: naming the author makes the record navigable, which is right for a channel
 *  already advertised and would give away both an unlisted one and its existence
 *  otherwise. Absent — an endorsement made before the channel loaded — resolves to null,
 *  which publishes the subject hash alone, and a catch-up fills the reference in later
 *  since it sits outside the signature. Null is the safe direction: less is revealed,
 *  never more.
 *
 *  One rule for every gesture, and it has to be: two endorsements of the same item
 *  disagreeing about the reference would each see the other as stale and rewrite it,
 *  waking every instance syncing the doc, forever. */
export async function referenceAuthorFor(
  channelID: string,
): Promise<ReferenceAuthor> {
  const { useFeedStore } = await import('../stores/feed')
  const manifest = useFeedStore.getState().manifests[channelID]
  return manifest?.visibility === 'public' && manifest.authorDidDht
    ? manifest.authorDidDht
    : null
}

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
  if (item.comment) {
    return endorse_comment_rkey(
      kind,
      item.comment.actor,
      item.comment.createdAt,
    )
  }
  return endorse_rkey(kind, item.channelID, item.publishedAt, item.attachment)
}

/** Sign and store one endorsement.
 *
 *  Skips the write when the record already says exactly this, so re-making a gesture
 *  doesn't churn the doc or wake every instance syncing it. The comparison is on the parts
 *  that carry meaning rather than on the whole record.
 *
 *  AN ENDORSEMENT KEEPS THE MOMENT IT WAS MADE. When a record already exists, its
 *  `createdAt` is reused rather than restamped, and only a genuinely new one takes `now`.
 *  Two consequences, both wanted: a rewrite that only changed the reference produces the
 *  IDENTICAL signature — ed25519 is deterministic and the reference sits outside the
 *  signed bytes — so a catch-up can fill in a reference it didn't know at first without
 *  re-signing anything. And a rewrite that followed the author's edit re-signs, correctly,
 *  while still saying the endorsement was made when it was made rather than when we
 *  noticed the edit.
 *
 *  Restamping instead would also make a retraction's recency guard meaningless: a
 *  withdrawal is honoured only if it is newer than the endorsement it withdraws, and an
 *  endorsement whose time crept forward on every pass could outrun one. */
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

  const held = decodeHeld(await getRecord(coll, rkey))
  if (held && !differs(held, item, referenceAuthor)) return false

  const madeAt = typeof held?.createdAt === 'string' ? held.createdAt : now
  const record = item.comment
    ? // No reference at any tier: a SubjectRef describes a post, and a comment's subject is
      // derived from neither its author's channel nor its timestamp, so coordinates here
      // would fail the record's own self-check.
      sign_comment_endorsement(
        appKeyHex,
        kind,
        item.comment.actor,
        item.comment.createdAt,
        item.contentHash ?? '',
        madeAt,
      )
    : sign_endorsement(
        appKeyHex,
        kind,
        item.channelID,
        item.publishedAt,
        item.contentHash ?? '',
        referenceAuthor ?? undefined,
        item.attachment,
        madeAt,
      )
  await putRecord(coll, rkey, new TextEncoder().encode(record))
  return true
}

/** When this identity's own endorsement of an item was made, or null when it holds none.
 *
 *  Presence and time in one read, because a row wants both: whether to fill the gesture,
 *  and whether the author's published count can have seen it yet. A record that won't
 *  parse reads as absent, the same as everywhere else here. */
export async function heldEndorsedAt(
  kind: EndorsementKind,
  item: EndorsedItem,
): Promise<string | null> {
  const [coll, rkey] = await Promise.all([
    collection(),
    endorsementRkey(kind, item),
  ])
  const held = decodeHeld(await getRecord(coll, rkey))
  if (!held) return null
  return typeof held.createdAt === 'string' ? held.createdAt : ''
}

/** A stored record, or null when there is none or it won't parse. Unreadable counts as
 *  absent: better to rewrite a record we can't verify than to leave one we can't account
 *  for in a count. */
function decodeHeld(
  stored: Uint8Array | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: a stored record is untrusted JSON
): any | null {
  if (!stored) return null
  try {
    return JSON.parse(new TextDecoder().decode(stored))
  } catch {
    return null
  }
}

/** Whether a stored record disagrees with what we would write now. */
function differs(
  // biome-ignore lint/suspicious/noExplicitAny: as above
  held: any,
  item: EndorsedItem,
  referenceAuthor: ReferenceAuthor,
): boolean {
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
