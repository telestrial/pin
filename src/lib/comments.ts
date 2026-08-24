// Writing a comment: forming the intent, and nothing else.
//
// One local doc write, the same shape a gesture takes. No Sia, no network, no journal —
// the record IS the intent, and everything after it belongs to the Curator: publishing the
// blob a crawl reads, knocking it through to the author, and being told when it goes. Its
// deliver loop wakes on a write to this collection, so a comment leaves within seconds of
// being written rather than at the next cadence.
//
// That division is why there is no "sending" state to model here. A comment is written or
// it isn't; whether the author has taken it in is a question about THEIR surface, answered
// by reading what they publish.

import {
  comment_collection,
  comment_rkey,
  max_comment_bytes,
  sign_comment,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import type { PinInput } from '../stores/pin'
import type { PublishedComment } from './channelConversations'
import { deleteRecord, getRecord, openDocs, putRecord } from './docs'
import type { EndorsedItem, ReferenceAuthor } from './engagement'
import { LIBRARY_CHANNEL } from './pinUpload'

/** The longest body a comment may carry, in bytes.
 *
 *  From Rust, because it is the limit the RECEIVER applies: a host refuses a body over it,
 *  so a composer that allowed more would produce records nobody would take. Bytes rather
 *  than characters for the same reason it is bytes there — bytes are what get allocated. */
export async function maxCommentBytes(): Promise<number> {
  await ensureWasm()
  return max_comment_bytes()
}

/** How many bytes a body would take, so a composer can count down honestly. */
export function bodyBytes(body: string): number {
  return new TextEncoder().encode(body).length
}

/** One comment this identity has written, as it sits in the doc. */
export type HeldComment = {
  commentID: string
  createdAt: string
  body: string
}

async function collection(): Promise<string> {
  await ensureWasm()
  return comment_collection()
}

/** Sign and store one comment, answering with its id.
 *
 *  A fresh record every time, unlike a gesture: a gesture is a singleton at its address, so
 *  re-making one rewrites it, where saying something twice is two things said. The id comes
 *  from Rust with the record rather than being derived here, so the address this writes to
 *  is the one the Curator will look for. */
export async function writeComment(
  appKeyHex: string,
  item: EndorsedItem,
  referenceAuthor: ReferenceAuthor,
  body: string,
  now = new Date().toISOString(),
): Promise<string> {
  await ensureWasm()
  await openDocs(appKeyHex)

  const { record, commentID } = JSON.parse(
    sign_comment(
      appKeyHex,
      item.channelID,
      item.publishedAt,
      item.contentHash ?? '',
      referenceAuthor ?? undefined,
      item.attachment,
      body,
      now,
    ),
  ) as { record: unknown; commentID: string }

  const subject = subjectOf(record)
  await putRecord(
    await collection(),
    comment_rkey(subject, commentID),
    new TextEncoder().encode(JSON.stringify(record)),
  )
  return commentID
}

/** Take one comment back.
 *
 *  Deleting the record is the whole of it. The author's crawl notices the absence, and for
 *  an author who learned of it by knock the deliver loop's orphan sweep tells them — the
 *  same two routes a withdrawn gesture takes, and the reason nothing here has to reach the
 *  network either. */
export async function withdrawComment(
  appKeyHex: string,
  item: EndorsedItem,
  commentID: string,
): Promise<void> {
  await ensureWasm()
  await openDocs(appKeyHex)
  const { engagement_subject } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  const subject = engagement_subject(
    item.channelID,
    item.publishedAt,
    item.attachment,
  )
  await deleteRecord(await collection(), comment_rkey(subject, commentID))
}

/** Whether this identity still holds the comment it wrote at one address.
 *
 *  What a row needs to offer taking it back: the published conversation says what the HOST
 *  is showing, which is a different question from what this identity still stands behind. */
export async function holdsComment(
  item: EndorsedItem,
  commentID: string,
): Promise<boolean> {
  await ensureWasm()
  const { engagement_subject } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  const subject = engagement_subject(
    item.channelID,
    item.publishedAt,
    item.attachment,
  )
  const held = await getRecord(
    await collection(),
    comment_rkey(subject, commentID),
  )
  return held !== null && held !== undefined
}

/** What keeping one comment pins, or null when there is nothing to keep.
 *
 *  Null until the comment's author has minted its body object — a comment written by
 *  somebody whose Curator has not run yet reads fine and offers no custody, because there
 *  is no address to take custody of.
 *
 *  Stored as a LIBRARY pin, which is what a kept comment is: bytes in your scope that were
 *  never published to a channel of yours. `origin` is what makes it more than loose bytes —
 *  it names the post the comment sits under, which locates the channel doc its counts live
 *  in, and the comment itself, which is what those counts are about.
 *
 *  `version` is the comment's signature. The signature covers the body, so it changes when
 *  the wording does and is stable otherwise, which is exactly what an endorsement's version
 *  records — and a comment carries no separate content hash to use instead. */
export function pinInputForComment(
  comment: PublishedComment,
  post: { channelID: string; publishedAt: string },
): PinInput | null {
  if (!comment.bodyURL || !comment.body) return null
  return {
    item: {
      // Never read for a pin: `pinItem` works off the share URL, and the object id comes
      // back from Sia. Empty is what every other synthesized ref here uses.
      id: '',
      itemURL: comment.bodyURL,
      type: 'text',
      title: '',
      summary: comment.body,
      // The comment's own time, so a kept comment sorts where it was said.
      publishedAt: comment.createdAt,
      mimeType: 'text/plain',
      byteSize: bodyBytes(comment.body),
      contentHash: comment.sig,
    },
    channel: LIBRARY_CHANNEL,
    origin: {
      channelID: post.channelID,
      publishedAt: post.publishedAt,
      commentActor: comment.actor,
      commentCreatedAt: comment.createdAt,
    },
  }
}

/** The subject a signed record names, read back off the record itself.
 *
 *  Off the record rather than recomputed, so the address a comment is stored at and the
 *  subject it was signed over cannot disagree — the class of bug that made a like and a pin
 *  share one address. */
function subjectOf(record: unknown): string {
  const subject = (record as { subject?: unknown })?.subject
  if (typeof subject !== 'string' || subject === '') {
    throw new Error('signed comment carries no subject')
  }
  return subject
}
