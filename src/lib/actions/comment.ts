import type { SiaClient } from '../../core/siaClient'
import type { CommentAction } from '../../stores/actionQueue'
import type { UploadedCommentFile } from '../comments'
import { uploadCommentFiles, writeComment } from '../comments'

// Writing a comment, as a resumable action.
//
// The one thing that differs from a post is custody: a post hands its bytes to the
// channel it is published on, and a comment goes on carrying its own — the record points
// at objects in the commenter's own scope. Everything else is the same two legs in the
// same order, and they were being awaited inline with nothing behind them: no progress
// while an attachment uploaded, no retry, and a tab closed between the upload and the
// record left bytes in this identity's scope that no record named and no mark reclaimed.
//
// RE-RUNNING IS SAFE BECAUSE THE ADDRESS IS FROZEN. A comment's id is
// `f(actor, createdAt)` and the intent carries `createdAt`, so a resume writes to the
// same rkey with the same bytes and lands the same record. A gesture gets this for free
// by being a singleton at its address; a comment would otherwise post twice, since
// saying something twice is two things said.

export type CommentContext = {
  client: SiaClient | null
  appKeyHex: string
  setPhase: (phase: string, progress?: number) => void
  setProgress: (progress: number) => void
  checkpoint: (carried: UploadedCommentFile[]) => void
}

export async function runComment(
  action: CommentAction,
  ctx: CommentContext,
): Promise<void> {
  const { client, appKeyHex, setPhase, setProgress, checkpoint } = ctx
  const intent = action.intent

  let carried: UploadedCommentFile[]
  if (action.ledger.uploaded) {
    carried = action.ledger.carried ?? []
    setPhase('Adding', 97)
  } else {
    let uploaded: UploadedCommentFile[] = []
    if (intent.sources.length > 0) {
      if (!client) throw new Error('Not connected to Sia yet')
      setPhase('Uploading', 0)
      let shards = 0
      const expected = 30
      uploaded = await uploadCommentFiles(client, intent.sources, () => {
        shards += 1
        setProgress(Math.min(95, (shards / expected) * 100))
      })
    }
    // Referenced files last, matching the order the composer showed them in: the
    // uploads take the leading slots because that is the order their bytes went up.
    carried = [...uploaded, ...intent.referenced]
    // Before the record names any of it, so an outage surfaces with nothing committed.
    checkpoint(carried)
    setPhase('Adding', 97)
  }

  await writeComment(
    appKeyHex,
    intent.subject,
    intent.referenceAuthor,
    intent.body,
    carried,
    intent.facets,
    intent.createdAt,
  )
}
