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
  comment_files_collection,
  comment_rkey,
  comment_seal_collection,
  max_comment_attachments,
  max_comment_bytes,
  sign_comment,
  sign_reply,
} from '../../crates/pin-core/pkg/pin_core.js'
import type { SiaClient } from '../core/siaClient'
import type { ItemType } from '../core/types'
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

/** How many files a comment may carry.
 *
 *  From Rust for the same reason the byte limit is: the host refuses a record over it, so a
 *  composer that let somebody pick one more would fail them at the signature, having already
 *  uploaded the file. */
export async function maxCommentAttachments(): Promise<number> {
  await ensureWasm()
  return max_comment_attachments()
}

/** Where in a comment's body a facet applies. UTF-8 BYTE offsets, matching how the body is
 *  measured everywhere else — a post's facets use the same convention. */
export type FacetIndex = { byteStart: number; byteEnd: number }

/** A mention inside a comment, anchored by DID.
 *
 *  Mirrors `pin_engagement::Facet`, and the field names are the contract: this is handed to
 *  Rust as JSON and parsed into that type, so a rename on either side is a runtime parse
 *  failure and nothing before it.
 *
 *  Byte-identical in shape to a post's facet, deliberately — a comment is post-shaped to a
 *  reader, so whatever renders a mention should not have to ask which it is looking at. */
export type CommentFacet = {
  index: FacetIndex
  features: { $type: string; did: string; handle?: string }[]
}

/** A file a comment carries, already uploaded.
 *
 *  Mirrors `pin_engagement::CommentAttachment`, and the field names are the contract — this
 *  is handed to Rust as JSON and parsed into that type, so a rename on either side is a
 *  parse failure rather than a compile error.
 *
 *  The bytes stay in the commenter's own Sia scope: a host publishes a comment's words and
 *  not its files, because words are bounded and a file is whatever the sender picked. So a
 *  reader fetches these from wherever the commenter put them, and they live exactly as long
 *  as the commenter goes on paying for them. */
export type CommentAttachment = {
  url: string
  mimeType: string
  filename?: string
  byteSize: number
  contentHash: string
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

async function sealCollection(): Promise<string> {
  await ensureWasm()
  return comment_seal_collection()
}

async function filesCollection(): Promise<string> {
  await ensureWasm()
  return comment_files_collection()
}

/** A file picked for a comment, before it has anywhere to live. */
export type CommentFileSource = {
  bytes: Uint8Array
  mimeType: string
  filename?: string
}

/** One uploaded file: what the record carries, and what reclaims it.
 *
 *  The object id is deliberately NOT in the record. A reader has no use for it — it names
 *  the object inside the commenter's own Sia scope, and what a reader needs is the share URL
 *  — while the commenter needs it to give the bytes back later. So it travels beside the
 *  attachment rather than inside it. */
export type UploadedCommentFile = {
  attachment: CommentAttachment
  /** Absent when the bytes were already in this scope for another reason — an armed library
   *  item, referenced rather than uploaded. Those must never enter the reclaim mark: the
   *  library still holds them, so giving them back on withdrawal would delete a pin. */
  objectID?: string
}

/** Put a comment's files on Sia, ready for a record to name them.
 *
 *  Bytes first and the record afterwards, which is the ordering every create in this
 *  codebase takes: a record must never name bytes that failed to land, and an outage should
 *  surface before anything commits.
 *
 *  Bin-packed through one upload rather than one apiece, the same as a post's attachments —
 *  Sia allocates in ~40 MiB slabs, so three small files uploaded separately would pay for
 *  three of them.
 *
 *  Refuses more files than a host would take, here rather than at the signature: finding out
 *  afterwards would mean having uploaded them first. */
export async function uploadCommentFiles(
  client: SiaClient,
  sources: CommentFileSource[],
  onProgress?: () => void,
): Promise<UploadedCommentFile[]> {
  if (sources.length === 0) return []
  const max = await maxCommentAttachments()
  if (sources.length > max) {
    throw new Error(`A comment can carry at most ${max} files`)
  }

  const uploaded = await client.uploadItemsPacked(
    sources.map((s) => s.bytes),
    onProgress,
  )
  return sources.map((source, i) => ({
    attachment: {
      url: uploaded[i].itemURL,
      mimeType: source.mimeType,
      filename: source.filename,
      byteSize: source.bytes.length,
      contentHash: uploaded[i].contentHash,
    },
    objectID: uploaded[i].id,
  }))
}

/** Which channel's key must seal a comment on this channel, or null to publish it as it
 *  stands.
 *
 *  The Curator publishes every comment this identity wrote into a blob the directory points
 *  at, and that blob is world-readable by design. For a comment on a PUBLIC post that is
 *  right — the words are as public as the post, and a stranger holding no key is exactly who
 *  has to be able to read them for the count to be auditable. For a post on a channel that
 *  is not public it would put a private conversation's words in front of anyone who resolved
 *  this identity. So the record goes into that blob sealed, under the key of the channel the
 *  post is on: whoever can read the post can read what was said on it, and nobody else, with
 *  no key to hand out.
 *
 *  Same input and same safe direction as `referenceAuthorFor`: only a manifest that SAYS
 *  public is treated as public. A manifest with no visibility field reads as obscure, which
 *  is the convention every reader here follows, and one that hasn't loaded reads as unknown —
 *  and unknown seals, because being sealed costs a reader who holds no key nothing they were
 *  promised, where being in the clear cannot be taken back. */
export async function sealChannelFor(
  channelID: string,
): Promise<string | null> {
  const { useFeedStore } = await import('../stores/feed')
  const manifest = useFeedStore.getState().manifests[channelID]
  return manifest?.visibility === 'public' ? null : channelID
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
  carried: UploadedCommentFile[] = [],
  facets: CommentFacet[] = [],
  now = new Date().toISOString(),
): Promise<string> {
  await ensureWasm()
  await openDocs(appKeyHex)

  const attachments = carried.map((c) => c.attachment)
  const files = attachments.length > 0 ? JSON.stringify(attachments) : undefined
  const marks = facets.length > 0 ? JSON.stringify(facets) : undefined

  // A REPLY when the thing being commented on is itself a comment. The same record either
  // way — only the subject differs, which is exactly what makes threading need no new
  // field: `subject` names anything, and a host registers every comment it holds as a
  // subject, so a reply is folded and counted against its parent the way a comment is
  // against a post.
  //
  // No reference on a reply, at any tier: a `SubjectRef` describes a post, and a comment's
  // subject is derived from neither an author nor a channel, so coordinates would not
  // reproduce it and the record's own self-check would reject them.
  const { record, commentID } = JSON.parse(
    item.comment
      ? sign_reply(
          appKeyHex,
          item.comment.actor,
          item.comment.createdAt,
          // A comment has no content hash; its signature is what a version records.
          item.contentHash ?? '',
          body,
          files,
          marks,
          now,
        )
      : sign_comment(
          appKeyHex,
          item.channelID,
          item.publishedAt,
          item.contentHash ?? '',
          referenceAuthor ?? undefined,
          item.attachment,
          body,
          files,
          marks,
          now,
        ),
  ) as { record: unknown; commentID: string }

  const subject = subjectOf(record)
  const rkey = comment_rkey(subject, commentID)

  // The mark BEFORE the record it classifies. A failure here leaves a mark with no comment,
  // which is inert; the other order would leave a comment nothing says to seal, and a
  // comment published in the clear cannot be un-published.
  const sealChannel = await sealChannelFor(item.channelID)
  if (sealChannel) {
    await putRecord(
      await sealCollection(),
      rkey,
      new TextEncoder().encode(JSON.stringify({ channelID: sealChannel })),
    )
  }
  // What to give back, also before the record, and for a second reason beyond ordering: a
  // record that then fails to write leaves bytes on Sia named by a mark whose comment does
  // not exist, which is exactly what the Curator's reclaim sweep collects. Written after
  // the upload because that is when the object ids exist, so a crash in between is the one
  // window that orphans anything — the same window a post's upload has.
  // Only what this comment MINTED. A file referenced out of the library came with its own
  // reason to exist and keeps it; naming it here would make withdrawing the comment delete
  // bytes the library still points at.
  const mintedIDs = carried
    .map((c) => c.objectID)
    .filter((id): id is string => !!id)
  if (mintedIDs.length > 0) {
    await putRecord(
      await filesCollection(),
      rkey,
      new TextEncoder().encode(JSON.stringify({ ids: mintedIDs })),
    )
  }
  await putRecord(
    await collection(),
    rkey,
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
  const rkey = comment_rkey(await subjectFor(item), commentID)
  // The record first, that being the withdrawal itself, and the seal mark after. A seal mark
  // left behind classifies nothing and is picked up by no pass.
  //
  // The FILES mark is deliberately left alone: it has to outlive the record, because once
  // the record is gone it is the only thing that still knows which objects to give back.
  // The Curator's sweep deletes it after the bytes.
  await deleteRecord(await collection(), rkey)
  await deleteRecord(await sealCollection(), rkey)
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
  const held = await getRecord(
    await collection(),
    comment_rkey(await subjectFor(item), commentID),
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
  comment: Pick<
    PublishedComment,
    'actor' | 'createdAt' | 'body' | 'bodyURL' | 'sig'
  >,
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

/** What keeping one FILE of a comment pins.
 *
 *  The escape hatch the attachment design names: a comment's files stay in its author's own
 *  Sia scope and last exactly as long as they go on paying for them, so anyone who wants one
 *  to outlive that takes custody of it with the gesture that already means custody. It is
 *  also what pin-on-a-comment means for a host, whose channel already publishes the words —
 *  the media is the only part with custody left at stake.
 *
 *  Mirrors the existing object rather than uploading: the bytes are already on Sia, so this
 *  is a second custodian for them and not a second copy.
 *
 *  `origin` names the comment AND the file, and the second half is load-bearing: without it
 *  this would be indistinguishable from keeping the comment, and the endorsement published
 *  for one would claim the other. See `endorsedItemFor`. */
export function pinInputForCommentFile(
  file: CommentAttachment,
  comment: Pick<PublishedComment, 'actor' | 'createdAt'>,
  post: { channelID: string; publishedAt: string },
): PinInput {
  return {
    item: {
      // A comment's file carries no object id — that id names an object in the COMMENTER's
      // scope, which is no use to anyone else — so the share URL is what keys the bytes, the
      // same fallback a legacy post attachment takes.
      id: file.url,
      itemURL: file.url,
      type: itemTypeForMime(file.mimeType),
      title: file.filename ?? '',
      // Stamped now: this is a copy made at this moment, and nothing else in the record says
      // what it is a copy of.
      publishedAt: new Date().toISOString(),
      mimeType: file.mimeType,
      byteSize: file.byteSize,
      // For a file the identity and the version are one hash: change the bytes and it is a
      // different file, so there is no drift to record separately.
      contentHash: file.contentHash,
      filename: file.filename,
    },
    channel: LIBRARY_CHANNEL,
    origin: {
      channelID: post.channelID,
      publishedAt: post.publishedAt,
      commentActor: comment.actor,
      commentCreatedAt: comment.createdAt,
      commentFileHash: file.contentHash,
    },
  }
}

/** What kind of library item a file reads as. Same mapping the post-attachment path uses;
 *  duplicated rather than shared because `filePin` speaks `AttachmentRef` and this speaks
 *  the comment's own shape, and three lines beat a type both sides have to satisfy. */
function itemTypeForMime(mimeType: string): ItemType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'text/html') return 'app'
  return 'file'
}

/** The subject a comment on this thing is addressed at.
 *
 *  One derivation for every caller that has to find a comment again — taking it back,
 *  asking whether we still hold it — so a reply cannot be written at one address and looked
 *  for at another. That class of bug is why the write path reads its subject off the signed
 *  record rather than recomputing it. */
async function subjectFor(item: EndorsedItem): Promise<string> {
  const { comment_subject, engagement_subject } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  return item.comment
    ? comment_subject(item.comment.actor, item.comment.createdAt)
    : engagement_subject(item.channelID, item.publishedAt, item.attachment)
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
