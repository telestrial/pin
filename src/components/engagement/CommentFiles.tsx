import type { CommentAttachment } from '../../lib/comments'
import { pinInputForCommentFile } from '../../lib/comments'
import { formatBytes } from '../../lib/format'
import { useItemBlobURL } from '../../lib/hooks/useItemBytes'
import { kindForMime, MediaPreview } from '../AttachmentMedia'
import { PinButton } from '../pin/PinButton'

// The files a comment carries, wherever a comment is met — under a post in its own thread,
// or under a post somebody circulated it onto. Shared rather than written twice, because a
// remark that rendered differently in the feed than in the thread would be two answers to
// one question.
//
// These bytes are the COMMENTER's. The host publishes a comment's words and holds a pointer
// at everything else, so a file here lasts exactly as long as its author goes on paying for
// it — and a repack on their side rewrites its URL until the host crawls them again. That is
// the designed degradation: words intact, media broken.

/** Whose comment this is, in the shape both the thread and the feed can supply. */
export type CommentIdentity = { actor: string; createdAt: string }

/** One file a comment carries, read from the commenter's own scope.
 *
 *  Shown small and never as a grid: a comment is a remark with something attached, where a
 *  post is the attachment with a remark on it, and giving them the same weight would make
 *  every thread read like a feed.
 *
 *  Offered with a pin, which is the whole answer to these bytes being somebody else's:
 *  taking custody is what makes one outlive its author's willingness to pay for it. Keeping
 *  a file is NOT keeping the comment — different bytes, different claim — so the two pins
 *  sit side by side and neither implies the other.
 */
function CommentFile({
  file,
  comment,
  post,
}: {
  file: CommentAttachment
  comment: CommentIdentity
  post: { channelID: string; publishedAt: string }
}) {
  const kind = kindForMime(file.mimeType)
  const { url, error } = useItemBlobURL(
    file.url,
    file.mimeType,
    file.contentHash,
  )
  const name = file.filename ?? 'file'

  // The failure this design accepts, said plainly rather than left as a blank tile: these
  // bytes are the commenter's, so a URL that has moved is unreadable here until the host
  // crawls them again.
  if (error) {
    return (
      <li className="text-xs text-neutral-400 truncate" title={name}>
        {name} — unavailable
      </li>
    )
  }
  return (
    <li className="max-w-56 overflow-hidden rounded-lg border border-neutral-200">
      <MediaPreview
        previewURL={url}
        kind={kind}
        filename={name}
        byteSize={file.byteSize}
      />
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-t border-neutral-200">
        <span className="text-xs text-neutral-400">
          {formatBytes(file.byteSize)}
        </span>
        <PinButton input={pinInputForCommentFile(file, comment, post)} />
      </div>
    </li>
  )
}

/** Every file one comment carries, or nothing when it carries none. */
export function CommentFiles({
  files,
  comment,
  post,
}: {
  files: CommentAttachment[] | undefined
  comment: CommentIdentity
  post: { channelID: string; publishedAt: string }
}) {
  if (!files || files.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-2">
      {files.map((f) => (
        <CommentFile
          key={f.contentHash}
          file={f}
          comment={comment}
          post={post}
        />
      ))}
    </ul>
  )
}
