import type { CommentAttachment } from '../../lib/comments'
import { pinInputForCommentFile } from '../../lib/comments'
import { AttachmentGrid } from '../AttachmentMedia'
import { PinButton } from '../pin/PinButton'

// The files a comment carries, wherever a comment is met — under a post in its own thread,
// on its own page, or under a post somebody circulated it onto.
//
// THE SAME GRID A POST'S ATTACHMENTS GET. These were smaller and capped once, on the
// reasoning that a comment is a remark with something attached where a post is the
// attachment with a remark on it. A comment is a post, so that reasoning is retired: the
// same picture met under a post and under a comment is one picture, and showing it two
// sizes was the app disagreeing with itself about what a comment is.
//
// These bytes are the COMMENTER's. The host publishes a comment's words and holds a pointer
// at everything else, so a file here lasts exactly as long as its author goes on paying for
// it — and a repack on their side rewrites its URL until the host crawls them again. That is
// the designed degradation, and the grid says so on the tile: words intact, media broken.

/** Whose comment this is, in the shape every site can supply. */
export type CommentIdentity = { actor: string; createdAt: string }

/** Every file one comment carries, or nothing when it carries none.
 *
 *  Each is offered with a pin, which is the whole answer to these bytes being somebody
 *  else's: taking custody is what makes one outlive its author's willingness to pay for it.
 *  Keeping a file is NOT keeping the comment — different bytes, different claim — so the two
 *  pins sit apart and neither implies the other. */
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
    <AttachmentGrid
      attachments={files}
      pin={(file) => (
        <PinButton input={pinInputForCommentFile(file, comment, post)} />
      )}
    />
  )
}
