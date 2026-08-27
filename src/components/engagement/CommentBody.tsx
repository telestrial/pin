import type { Facet } from '../../core/types'
import { RichBody } from '../RichBody'
import { CommentFiles } from './CommentFiles'
import { CommentEngagementRow } from './EngagementRow'

// What a comment IS, below whoever wrote it: the words, the files they go on carrying, and
// the gestures anybody can make on it.
//
// One component because there are three places a comment is met — in a post's thread, on
// its own page, and in the feed when somebody circulated it — and a comment met in one must
// be the same thing as a comment met in another. Assembled by hand at each site, the three
// were already drifting: only two of them had the same order, and a fourth element would
// have had to be remembered three times or silently appear in one.
//
// The row around it is NOT here. Each site frames a comment differently — a thread puts a
// withdraw beneath it, a page has no open handler because the row IS the thing already
// open, the feed hangs a repost line above — and those are genuine differences about
// context rather than about what a comment is.

/** The post a comment sits under, which its files and its counts are both addressed
 *  through. */
export type CommentHost = { channelID: string; publishedAt: string }

/** Everything this needs of a comment, and nothing about where it came from.
 *
 *  STRUCTURAL rather than one of the named comment types, for the reason the engagement row
 *  is: the three sites read from three different layers — a published conversation, a
 *  comment page, and the feed's own collation — and a component that named one of them
 *  would force the other two to convert. `sig` is what a keep is addressed by; `bodyURL` is
 *  what makes the words keepable at all, absent until its author's Curator has minted it. */
export type CommentContents = {
  actor: string
  createdAt: string
  body?: string
  bodyURL?: string
  sig: string
  attachments?: {
    url: string
    mimeType: string
    filename?: string
    byteSize: number
    contentHash: string
  }[]
  facets?: Facet[]
}

export function CommentBody({
  comment,
  post,
  onHandleClick,
}: {
  comment: CommentContents
  post: CommentHost
  onHandleClick?: (id: string) => void
}) {
  return (
    <>
      <RichBody
        body={comment.body ?? ''}
        facets={comment.facets}
        onHandleClick={onHandleClick}
      />
      <CommentFiles files={comment.attachments} comment={comment} post={post} />
      <CommentEngagementRow comment={comment} post={post} />
    </>
  )
}

/** Where a comment was said, for the two places it is met away from the post it is on.
 *
 *  Written twice before this — once as a component in the feed and once as a bare paragraph
 *  on the comment page — which is how one of them ends up styled differently than the
 *  other. A comment lifted out of its thread is the decontextualized-quote problem, so this
 *  line is what stops it being one. */
export function ReplyingTo({ name }: { name: string }) {
  return <p className="text-xs text-neutral-500 truncate">Replying to {name}</p>
}
