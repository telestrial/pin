import { Heart, MessageCircle } from 'lucide-react'
import type { FeedEntry } from '../../core/feed'
import { pinInputForComment } from '../../lib/comments'
import type { EndorsedItem } from '../../lib/engagement'
import { useEngagement } from '../../lib/hooks/useEngagement'
import {
  commentRepostTargetFor,
  type PortalTarget,
  repostTargetFor,
} from '../../lib/repost'
import { useFeedStore } from '../../stores/feed'
import type { PinInput } from '../../stores/pin'
import { PinButton } from '../pin/PinButton'
import { RepostButton } from './RepostButton'

// The gestures an item carries, and what they add up to.
//
// The pin lives here rather than up in the header, where it sat while it was the only one.
// It is the same gesture it always was — a pin mirrors bytes into your Sia scope, and on
// your OWN post it is a retract — but it now stands beside a count, because a pin is a
// redundancy count before it is a popularity one: publishing makes you pin #1, and the
// number falling to zero would mean nobody is paying to keep the bytes alive.
//
// The recycle beside them is the third gesture and the only one that publishes: it puts
// a reference to this post into one of your own channels. Its count is how many of YOUR
// channels carry it, which is a different question from the two beside it — those count
// everybody.
//
// A count of zero shows nothing. Absent and zero mean the same thing to a reader, and one
// of them is far the more common: most items are unendorsed, and an item whose channel no
// pass has read counts for yet reads identically.
//
// ONE ROW, TWO ADAPTERS. A post and a comment carry the same four gestures and must look
// identical doing it, but they answer three questions differently: what the counts are
// ABOUT (a post's subject comes from its channel and publish time, a comment's from who
// wrote it and when), what the pin takes custody OF (a post's bytes, a comment's body
// object — which may not exist yet), and what a repost would circulate. So the layout is
// one component and each shape gets a small adapter that answers those three. Two
// components drawing the same row is how they drift; two adapters over one cannot.

/** A count beside its gesture, or nothing when there is none to show. */
function Count({ n }: { n: number }) {
  if (n === 0) return null
  return <span className="text-xs tabular-nums text-neutral-500">{n}</span>
}

/** The gestures themselves, over whatever subject the adapter below named. */
function Row({
  item,
  pin,
  repostTarget,
  sourceName,
}: {
  /** What every count here is about. */
  item: EndorsedItem
  /** What the pin takes custody of, or null when there is nothing to keep yet — a comment
   *  whose author has not minted its body object has no address to take custody of. */
  pin: PinInput | null
  /** What a repost would circulate, or null when it cannot be. */
  repostTarget: PortalTarget | null
  /** The source channel's name, for the repost menu's cached label. */
  sourceName?: string
}) {
  const { likes, pins, reposts, comments, liked, toggleLike, busy } =
    useEngagement(item)

  // The row that contains this is itself a click target for opening the item, so a
  // gesture has to stop there rather than also navigating — the same thing PinButton
  // does with its own click.
  const handleLike = (e: React.MouseEvent) => {
    e.stopPropagation()
    toggleLike()
  }

  return (
    <div className="flex items-center gap-3 -ml-1">
      <div className="flex items-center gap-1">
        <Count n={likes} />
        <button
          type="button"
          onClick={handleLike}
          disabled={busy}
          title={liked ? 'Remove your like' : 'Like'}
          aria-pressed={liked}
          className={`p-1 cursor-pointer transition-all duration-300 disabled:cursor-default disabled:opacity-50 ${
            liked
              ? 'text-rose-500 opacity-80 hover:opacity-100'
              : 'text-neutral-400 hover:text-rose-400'
          }`}
        >
          <Heart
            className="size-5"
            strokeWidth={1.5}
            fill={liked ? 'currentColor' : 'none'}
            aria-hidden="true"
          />
        </button>
      </div>

      {pin && (
        <div className="flex items-center gap-1">
          <Count n={pins} />
          <PinButton input={pin} />
        </div>
      )}

      <RepostButton
        target={repostTarget}
        sourceName={sourceName}
        contentHash={item.contentHash}
        count={reposts}
      />

      {/* An indicator rather than a button, and deliberately: liking is something you do
          FROM a row, where commenting is something you do in the thread. It does not stop
          the click, so in a feed it opens the post — which is where the conversation it
          counts already lives — and on a page that already shows that conversation it
          does nothing, which is correct. */}
      <div
        className="flex items-center gap-1 text-neutral-400"
        title={comments === 1 ? '1 comment' : `${comments} comments`}
      >
        <Count n={comments} />
        <MessageCircle
          className="size-5"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}

/** The gestures on a POST.
 *
 *  Its subject comes from the channel it was published in and when — this codebase's
 *  logical-post identity, preserved across edits — and its pin always has something to take
 *  custody of, because the bytes exist by the time anyone can see it.
 */
export function EngagementRow({
  input,
  entry,
}: {
  input: PinInput
  // Present wherever the post came out of the feed, which is everywhere a repost makes
  // sense. Absent on a library item, which has no channel to be circulated out of.
  entry?: FeedEntry
}) {
  const manifests = useFeedStore((s) => s.manifests)
  return (
    <Row
      item={{
        channelID: input.channel.channelID,
        publishedAt: input.item.publishedAt,
        contentHash: input.item.contentHash,
      }}
      pin={input}
      repostTarget={entry ? repostTargetFor(entry, manifests) : null}
      sourceName={entry?.channel.name}
    />
  )
}

/** The gestures on a COMMENT, which are the same gestures.
 *
 *  Three things differ and all three are about identity rather than about the row. Its
 *  subject is derived from who wrote it and when, so nobody can reassign it. Its version is
 *  the signature, which moves when the words do and is stable otherwise — a comment carries
 *  no separate content hash. And its pin is null until its author has minted its body
 *  object, because there is nothing to take custody of until there is an address.
 *
 *  Its comment count is its REPLIES, which falls out of the fold rather than needing
 *  anything: a subject can name a comment, so a reply is counted against the comment the
 *  same way a comment is counted against the post.
 */
export function CommentEngagementRow({
  comment,
  post,
}: {
  comment: {
    actor: string
    createdAt: string
    body?: string
    bodyURL?: string
    sig: string
  }
  post: { channelID: string; publishedAt: string }
}) {
  const manifests = useFeedStore((s) => s.manifests)
  return (
    <Row
      item={{
        channelID: post.channelID,
        publishedAt: post.publishedAt,
        contentHash: comment.sig,
        comment: { actor: comment.actor, createdAt: comment.createdAt },
      }}
      pin={pinInputForComment(comment, post)}
      repostTarget={commentRepostTargetFor(comment, post, manifests)}
      sourceName={manifests[post.channelID]?.name}
    />
  )
}
