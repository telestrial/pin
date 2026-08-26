import { Paperclip, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PublishedComment } from '../../lib/channelConversations'
import {
  bodyBytes,
  type CommentFileSource,
  uploadCommentFiles,
  withdrawComment,
  writeComment,
} from '../../lib/comments'
import type { EndorsedItem } from '../../lib/engagement'
import { referenceAuthorFor } from '../../lib/engagement'
import { formatBytes } from '../../lib/format'
import { useConversation } from '../../lib/hooks/useConversation'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { PostRow } from '../PostRow'
import { CommentFiles } from './CommentFiles'
import { CommentEngagementRow } from './EngagementRow'

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

/** A file chosen but not yet uploaded. Held as bytes because that is what the upload takes,
 *  and because a comment that is never submitted must leave nothing behind on Sia. */
type PickedFile = CommentFileSource & { id: string }

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
        <p className="text-sm text-neutral-900 whitespace-pre-wrap break-words">
          {comment.body}
        </p>
        <CommentFiles
          files={comment.attachments}
          comment={comment}
          post={post}
        />
        <CommentEngagementRow comment={comment} post={post} />
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
  const takesComments =
    useFeedStore((s) => s.manifests[item.channelID])?.comments === true
  const conversation = useConversation(item)

  const client = useAuthStore((s) => s.client)

  const [draft, setDraft] = useState('')
  const [limit, setLimit] = useState(LIMIT_UNKNOWN)
  const [fileCap, setFileCap] = useState(FILE_CAP_UNKNOWN)
  const [picked, setPicked] = useState<PickedFile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)

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

  const used = bodyBytes(draft)
  const overLimit = limit !== LIMIT_UNKNOWN && used > limit
  const full = fileCap !== FILE_CAP_UNKNOWN && picked.length >= fileCap

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const body = draft.trim()
    if (!storedKeyHex || !body || overLimit || busy) return
    if (picked.length > 0 && !client) {
      setError('Not connected to Sia yet')
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Bytes first, then the record that names them — an outage surfaces before anything
      // is written, and a record never points at files that failed to land.
      const carried =
        picked.length > 0 && client
          ? await uploadCommentFiles(client, picked)
          : []
      await writeComment(
        storedKeyHex,
        item,
        await referenceAuthorFor(item.channelID),
        body,
        carried,
      )
      setDraft('')
      setPicked([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that comment')
    } finally {
      setBusy(false)
    }
  }

  async function pick(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    const room = fileCap - picked.length
    if (room <= 0) return
    const taken = Array.from(files).slice(0, room)
    if (taken.length < files.length) {
      // Said rather than silently dropped: a picker that quietly took three of five would
      // publish a comment missing files the person believed they had attached.
      setError(`A comment can carry at most ${fileCap} files`)
    }
    const read = await Promise.all(
      taken.map(async (f) => ({
        id: `${f.name}:${f.size}:${f.lastModified}`,
        bytes: new Uint8Array(await f.arrayBuffer()),
        mimeType: f.type || 'application/octet-stream',
        filename: f.name,
      })),
    )
    setPicked((held) => [...held, ...read])
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
    <section className="space-y-4">
      <h2 className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
        Comments
      </h2>

      {comments.length > 0 ? (
        <ul className="space-y-3">
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
      ) : (
        <p className="text-sm text-neutral-500">Nothing here yet.</p>
      )}

      <form onSubmit={submit} className="space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          rows={2}
          placeholder="Say something"
          className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
        />

        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {picked.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-1.5 px-2 py-1 bg-neutral-100 rounded-lg text-xs text-neutral-700"
              >
                <span className="max-w-40 truncate">{f.filename}</span>
                <span className="text-neutral-400">
                  {formatBytes(f.bytes.length)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPicked((held) => held.filter((h) => h.id !== f.id))
                  }
                  disabled={busy}
                  aria-label={`Remove ${f.filename}`}
                  className="text-neutral-400 hover:text-neutral-900 cursor-pointer disabled:cursor-default"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-neutral-500">
            {error ??
              (overLimit
                ? `${used - limit} bytes too long`
                : // Bytes, because bytes are what the receiver counts.
                  `${used}${limit === LIMIT_UNKNOWN ? '' : ` / ${limit}`} bytes`)}
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void pick(e.target.files)
                // Cleared so picking the same file twice in a row still fires a change.
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => filePicker.current?.click()}
              disabled={busy || fileCap === FILE_CAP_UNKNOWN || full}
              aria-label="Attach a file"
              title={full ? `At most ${fileCap} files` : 'Attach a file'}
              className="p-1.5 text-neutral-500 hover:text-neutral-900 cursor-pointer disabled:text-neutral-300 disabled:cursor-default"
            >
              <Paperclip size={16} />
            </button>
            <button
              type="submit"
              disabled={busy || overLimit || draft.trim() === ''}
              className="px-3 py-1.5 text-sm font-medium text-white bg-green-700 hover:bg-green-600 rounded-lg transition-colors cursor-pointer disabled:bg-neutral-300 disabled:cursor-default"
            >
              {busy ? 'Adding…' : 'Comment'}
            </button>
          </div>
        </div>
      </form>
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
