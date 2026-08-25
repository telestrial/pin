// What a channel's readers said, as reached from a screen.
//
// The same two rungs a count takes and read the same way. The fast one is a live-synced
// copy of the author's own fold, which lands in the channel's own iroh-docs replica; the
// durable one is a per-channel map on Sia behind a DHT resolve and a download, which
// everyone holding K can reach and nobody wants to walk per row. So the Curator's loops
// land both at one address in this identity's own doc and a screen reads that.
//
// Apart from the counts, and deliberately: a feed row wants a number, where the words are
// wanted only when a post is opened. Merging them would make every row in a feed carry
// every comment body in it.

import {
  comment_subject,
  engagement_subject,
  thread_collection,
  thread_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
import { channelKeyFromBase64 } from '../core/crypto'
import { ensureWasm } from '../core/wasm'
import {
  fetchConversations,
  resolveConversationsUrl,
} from './channelLocatorNative'
import type { CommentAttachment } from './comments'
import { getRecord, openDocs, putRecord } from './docs'
import type { EndorsedItem } from './engagement'

/** One comment, as its author signed it.
 *
 *  Verbatim, so a reader checks the signature against the actor's own key rather than
 *  trusting whoever published the page it appears on — which is what makes the words
 *  attributable to the person who wrote them instead of to the host displaying them. */
export type PublishedComment = {
  kind: string
  actor: string
  subject: string
  version: string
  createdAt: string
  sig: string
  body?: string
  // Where the same words sit as a Sia object of the commenter's own. A custody handle and
  // never the read path: the body above is what renders. Absent on a comment whose author
  // has not run a Curator, which is why keeping one is offered conditionally.
  bodyURL?: string
  // Files the commenter carries, in their own scope rather than the host's. So these can go
  // stale where the words cannot — a repack on the commenter's side rewrites every URL here
  // until the host crawls them again, and a comment degrades as words intact, media broken.
  attachments?: CommentAttachment[]
}

/** One subject's published conversation, newest first. */
export type Conversation = {
  comments: PublishedComment[]
  updatedAt: string
}

async function threadAddress(item: EndorsedItem): Promise<[string, string]> {
  await ensureWasm()
  return [
    thread_collection(),
    thread_rkey(
      item.channelID,
      // A comment's own conversation is its replies, addressed by the comment.
      item.comment
        ? comment_subject(item.comment.actor, item.comment.createdAt)
        : engagement_subject(item.channelID, item.publishedAt, item.attachment),
    ),
  ]
}

/** An item's conversation as this identity currently holds it, or null when nothing is
 *  cached — which is ordinary and means the same as none: nobody has commented, or no pass
 *  has read this channel's conversations yet. */
export async function readConversation(
  appKeyHex: string,
  item: EndorsedItem,
): Promise<Conversation | null> {
  try {
    await openDocs(appKeyHex)
    const [collection, rkey] = await threadAddress(item)
    const stored = await getRecord(collection, rkey)
    if (!stored) return null
    return JSON.parse(new TextDecoder().decode(stored)) as Conversation
  } catch {
    // A cache that won't open or won't parse reads as no comments, which is what a post
    // with none shows anyway. Nothing about a conversation is worth failing a render over.
    return null
  }
}

/** Read one channel's published conversations and cache them, for a channel no pass has
 *  covered yet — a just-pasted subscribe URL, or a tab whose loop hasn't come round.
 *
 *  The fall-through rung, and the counterpart of warming a channel's counts. Best-effort
 *  and unawaited by its caller: a channel with no published conversations is the common
 *  case rather than a failure. */
export async function warmChannelConversations(
  appKeyHex: string,
  channelID: string,
  channelKeyB64: string,
): Promise<void> {
  try {
    const k = channelKeyFromBase64(channelKeyB64)
    const itemURL = await resolveConversationsUrl(k)
    if (!itemURL) return

    const map = JSON.parse(await fetchConversations(k, itemURL)) as Record<
      string,
      Conversation
    >
    await openDocs(appKeyHex)
    await ensureWasm()
    const collection = thread_collection()
    const encoder = new TextEncoder()
    for (const [subject, conversation] of Object.entries(map)) {
      await putRecord(
        collection,
        thread_rkey(channelID, subject),
        encoder.encode(JSON.stringify(conversation)),
      )
    }
  } catch {
    // The Curator's loops cover this channel on their own cadence, so a failure here costs
    // a pass rather than the words.
  }
}
