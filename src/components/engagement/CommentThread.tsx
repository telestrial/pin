import { useEffect, useState } from 'react'
import type { SiaClient } from '../../core/siaClient'
import type { PublishedComment } from '../../lib/channelConversations'
import {
  type UploadedCommentFile,
  uploadCommentFiles,
  withdrawComment,
  writeComment,
} from '../../lib/comments'
import type { EndorsedItem } from '../../lib/engagement'
import { referenceAuthorFor } from '../../lib/engagement'
import { useConversation } from '../../lib/hooks/useConversation'
import {
  useIdentityName,
  useIdentityProfile,
} from '../../lib/hooks/useIdentityName'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import {
  type AttachmentDraft,
  Composer,
  type ComposerSubmission,
} from '../Composer'
import { IdentityAvatar } from '../IdentityAvatar'
import { PostRow } from '../PostRow'
import { CommentBody } from './CommentBody'

// A post's conversation, and somewhere to add to it.
//
// Only on a post whose channel takes comments — absent on the manifest reads as off, so
// every channel written before the field is a quiet one and stays that way until its owner
// says otherwise.
//
// WHAT IS SHOWN IS WHAT THE AUTHOR PUBLISHES, not what this identity wrote. A comment
// written here lands in this identity's own doc and reaches the author by the Curator's own
// routes; whether they took it in is a question about THEIR surface, answered by it
// appearing below. So there is no pending state to render and none is invented: an
// unanswered comment simply isn't in the thread yet.
//
// KEEPING one is offered when its author has minted its body object, and not before: there
// is nothing to take custody of until there is an address, and a comment whose author has
// never run a Curator has none. A kept comment is a library pin — bytes in your scope that
// were never published to a channel of yours — whose origin names the post it sits under.
//
// FILES belong to the commenter, not to the host. The host publishes the words and holds a
// pointer at everything else, so a comment's media reads out of whoever wrote it's own Sia
// scope and lasts exactly as long as they go on paying for it. Which is why a broken file
// here is ordinary rather than alarming: a repack on their side rewrites the URL until the
// host next crawls them, and the conversation survives its pictures.

/** How much a composer will take, in bytes. Read once — it comes from the receiver's own
 *  limit, so a form that allowed more would produce records nobody would keep. */
const LIMIT_UNKNOWN = 0

/** How many files a comment may carry, before the answer has come back from Rust. Zero
 *  reads as "not yet known", and the picker stays shut until it is — offering a file the
 *  record could not hold would fail at the signature, having uploaded it first. */
const FILE_CAP_UNKNOWN = 0

/** A comment's files, ready for the record to name them.
 *
 *  Two kinds arrive from the composer and they are handled differently for one reason:
 *  whether the bytes exist yet. Something picked off the disk is uploaded into the
 *  commenter's own scope and becomes reclaimable when the comment goes. Something already
 *  in that scope — an armed library item — is referenced where it stands and carries NO
 *  object id, because the library still holds those bytes and withdrawing the comment must
 *  not take them from it.
 *
 *  A library item with no content hash is refused rather than patched over: the record
 *  requires one and every reader self-checks the URL against it, so there is nothing honest
 *  to put there. Only items predating the field are affected. */
async function carryFiles(
  client: SiaClient | null,
  drafts: AttachmentDraft[],
): Promise<UploadedCommentFile[]> {
  const referenced: UploadedCommentFile[] = []
  const sources = []
  for (const a of drafts) {
    if (a.source === 'bytes') {
      sources.push({
        bytes: a.bytes,
        mimeType: a.mimeType,
        filename: a.filename,
      })
      continue
    }
    if (!a.contentHash) {
      throw new Error(`${a.filename} has no content hash and can't be attached`)
    }
    referenced.push({
      attachment: {
        url: a.url,
        mimeType: a.mimeType,
        filename: a.filename,
        byteSize: a.byteSize,
        contentHash: a.contentHash,
      },
    })
  }
  const uploaded =
    sources.length > 0 && client
      ? await uploadCommentFiles(client, sources)
      : []
  return [...uploaded, ...referenced]
}

function CommentRow({
  comment,
  post,
  onWithdraw,
  onOpenPerson,
  onOpen,
}: {
  comment: PublishedComment
  post: { channelID: string; publishedAt: string }
  onWithdraw?: () => void
  onOpenPerson?: (id: string) => void
  /** Opening this comment's own page, where its replies are. */
  onOpen?: () => void
}) {
  return (
    <li>
      <PostRow
        identity={{ kind: 'person', didDht: comment.actor }}
        at={comment.createdAt}
        onOpen={onOpen}
        onOpenPerson={onOpenPerson}
      >
        <CommentBody
          comment={comment}
          post={post}
          onHandleClick={onOpenPerson}
        />
        {/* Taking your own back. Below the gestures rather than in the header, because it
            is not one of them: the others are things anybody does to a comment, and this is
            the only thing only its author can do. */}
        {onWithdraw && (
          <button
            type="button"
            onClick={onWithdraw}
            className="text-xs text-neutral-500 hover:text-neutral-900 cursor-pointer"
          >
            remove
          </button>
        )}
      </PostRow>
    </li>
  )
}

export function CommentThread({
  item,
  onHandleClick,
  onOpenComment,
}: {
  item: EndorsedItem
  /** Opening whoever wrote a comment. A commenter is a person rather than a channel, so
   *  this is the same handler a post row uses for its author. */
  onHandleClick?: (handle: string) => void
  /** Opening one comment's own page, where its replies are. Absent where there is nowhere
   *  to go — a comment row still renders, it just does not open. */
  onOpenComment?: (comment: PublishedComment) => void
}) {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const myProfile = useIdentityProfile(myDidDht ?? '')
  const myName = useIdentityName(myDidDht ?? '')
  const takesComments =
    useFeedStore((s) => s.manifests[item.channelID])?.comments === true
  const conversation = useConversation(item)

  const client = useAuthStore((s) => s.client)

  const [limit, setLimit] = useState(LIMIT_UNKNOWN)
  const [fileCap, setFileCap] = useState(FILE_CAP_UNKNOWN)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { maxCommentBytes, maxCommentAttachments } = await import(
        '../../lib/comments'
      )
      const [max, files] = await Promise.all([
        maxCommentBytes(),
        maxCommentAttachments(),
      ])
      if (!cancelled) {
        setLimit(max)
        setFileCap(files)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!takesComments) return null

  // The ONE thing that differs from writing a post, which is why everything else is shared:
  // a post hands its bytes to the channel it is published on, and a comment goes on
  // carrying its own — the record points at objects in the commenter's own scope.
  async function submit(submission: ComposerSubmission) {
    if (!storedKeyHex) throw new Error('Not signed in')
    if (submission.attachments.length > 0 && !client) {
      const message = 'Not connected to Sia yet'
      setError(message)
      throw new Error(message)
    }
    setBusy(true)
    setError(null)
    try {
      // Bytes first, then the record that names them — an outage surfaces before anything
      // is written, and a record never points at files that failed to land.
      const carried = await carryFiles(client, submission.attachments)
      await writeComment(
        storedKeyHex,
        item,
        await referenceAuthorFor(item.channelID),
        submission.body,
        carried,
        submission.facets,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that comment')
      // Rethrown so the composer keeps the draft: nothing was published, so nothing the
      // person wrote should disappear.
      throw e
    } finally {
      setBusy(false)
    }
  }

  async function remove(comment: PublishedComment) {
    if (!storedKeyHex) return
    try {
      await withdrawComment(
        storedKeyHex,
        item,
        // Derived from the record, the same way its address was.
        await commentIDOf(comment),
      )
    } catch {
      // The record is either gone or it isn't; the thread re-reads either way when the
      // author next publishes, so there is nothing to report that a retry wouldn't fix.
    }
  }

  const comments = conversation?.comments ?? []

  return (
    // Its own card on the app's canvas, the way every other block of content is. It brings
    // the card with it rather than being wrapped by its callers, because it renders NOTHING
    // on a channel that takes no comments — and a caller wrapping it would leave an empty
    // card sitting under those posts.
    <section className="space-y-4">
      {/* The composer FIRST and unlabelled, the way the feed's is. A box you can type in
          says what it is; a heading over it is the app explaining its own furniture. It
          sits above the replies for the same reason every microblog puts it there — the
          thing you came to do is nearer than the thing you came to read. */}
      <Composer
        avatar={
          /* Yourself, not a channel: a comment is written as you. The feed's composer
             shows the voice you are publishing AS, and a comment has none to pick. */
          <IdentityAvatar
            didDht={myDidDht ?? ''}
            name={myName}
            avatarURL={myProfile?.avatarURL ?? undefined}
          />
        }
        placeholder="Say something"
        submitLabel="Reply"
        busyLabel="Adding…"
        busy={busy}
        error={error}
        /* BYTES, not characters: a host counts bytes and would refuse a longer record, so
           counting anything else here would let someone write what cannot be published. */
        limit={{ unit: 'bytes', max: limit === LIMIT_UNKNOWN ? null : limit }}
        attachmentCap={fileCap === FILE_CAP_UNKNOWN ? 0 : fileCap}
        attachmentCapMessage={`A comment can carry at most ${fileCap} files`}
        bodyTextClass="text-sm"
        onSubmit={submit}
      />

      {comments.length > 0 && (
        <ul className="bg-white border border-neutral-200 rounded-lg p-5 space-y-3">
          {comments.map((c) => (
            <CommentRow
              key={c.sig}
              comment={c}
              post={{
                channelID: item.channelID,
                publishedAt: item.publishedAt,
              }}
              onWithdraw={
                c.actor === myDidDht ? () => void remove(c) : undefined
              }
              onOpenPerson={onHandleClick}
              onOpen={onOpenComment && (() => onOpenComment(c))}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** A published comment's own id, derived from the record exactly as the address was.
 *
 *  From Rust, so what this identity deletes is what it wrote: deriving the id a second way
 *  here would be a second implementation of the record's identity. */
async function commentIDOf(comment: PublishedComment): Promise<string> {
  const { comment_subject } = await import(
    '../../../crates/pin-core/pkg/pin_core.js'
  )
  return comment_subject(comment.actor, comment.createdAt)
}
