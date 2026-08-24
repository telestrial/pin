import { useEffect, useState } from 'react'
import type { PublishedComment } from '../../lib/channelConversations'
import {
  bodyBytes,
  pinInputForComment,
  withdrawComment,
  writeComment,
} from '../../lib/comments'
import type { EndorsedItem } from '../../lib/engagement'
import { referenceAuthorFor } from '../../lib/engagement'
import { useConversation } from '../../lib/hooks/useConversation'
import { useIdentityName } from '../../lib/hooks/useIdentityName'
import { formatRelative } from '../../lib/time'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { PinButton } from '../pin/PinButton'

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

/** How much a composer will take, in bytes. Read once — it comes from the receiver's own
 *  limit, so a form that allowed more would produce records nobody would keep. */
const LIMIT_UNKNOWN = 0

function CommentRow({
  comment,
  post,
  onWithdraw,
}: {
  comment: PublishedComment
  post: { channelID: string; publishedAt: string }
  onWithdraw?: () => void
}) {
  const name = useIdentityName(comment.actor)
  const keepable = pinInputForComment(comment, post)
  return (
    <li className="space-y-1">
      <p className="text-xs text-neutral-500">
        <span className="font-medium text-neutral-700">@{name}</span> ·{' '}
        {formatRelative(comment.createdAt)}
        {onWithdraw && (
          <>
            {' · '}
            <button
              type="button"
              onClick={onWithdraw}
              className="text-neutral-500 hover:text-neutral-900 cursor-pointer"
            >
              remove
            </button>
          </>
        )}
      </p>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-neutral-900 whitespace-pre-wrap break-words">
          {comment.body}
        </p>
        {keepable && <PinButton input={keepable} />}
      </div>
    </li>
  )
}

export function CommentThread({ item }: { item: EndorsedItem }) {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const takesComments =
    useFeedStore((s) => s.manifests[item.channelID])?.comments === true
  const conversation = useConversation(item)

  const [draft, setDraft] = useState('')
  const [limit, setLimit] = useState(LIMIT_UNKNOWN)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { maxCommentBytes } = await import('../../lib/comments')
      const max = await maxCommentBytes()
      if (!cancelled) setLimit(max)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!takesComments) return null

  const used = bodyBytes(draft)
  const overLimit = limit !== LIMIT_UNKNOWN && used > limit

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const body = draft.trim()
    if (!storedKeyHex || !body || overLimit || busy) return
    setBusy(true)
    setError(null)
    try {
      await writeComment(
        storedKeyHex,
        item,
        await referenceAuthorFor(item.channelID),
        body,
      )
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that comment')
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
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-neutral-500">
            {error ??
              (overLimit
                ? `${used - limit} bytes too long`
                : // Bytes, because bytes are what the receiver counts.
                  `${used}${limit === LIMIT_UNKNOWN ? '' : ` / ${limit}`} bytes`)}
          </p>
          <button
            type="submit"
            disabled={busy || overLimit || draft.trim() === ''}
            className="px-3 py-1.5 text-sm font-medium text-white bg-green-700 hover:bg-green-600 rounded-lg transition-colors cursor-pointer disabled:bg-neutral-300 disabled:cursor-default"
          >
            {busy ? 'Adding…' : 'Comment'}
          </button>
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
