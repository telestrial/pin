import type { FeedChannel } from '../core/feed'
import type { PublishedComment } from '../lib/channelConversations'
import type { EndorsedItem } from '../lib/engagement'
import { CommentFiles } from './engagement/CommentFiles'
import { CommentThread } from './engagement/CommentThread'
import { CommentEngagementRow } from './engagement/EngagementRow'
import { PostRow } from './PostRow'
import { RichBody } from './RichBody'

// One comment, and what was said back to it.
//
// The same page a post gets, one level down — which is Twitter's shape and the one that
// follows from a comment being post-shaped everywhere else. A reply is a comment whose
// subject is this comment, so everything below is the machinery a post's conversation
// already uses, pointed at a different subject.
//
// FLAT, one level at a time: this shows the replies to THIS comment, and each of those
// carries its own reply count and its own page. Mixing replies-to-replies into one list
// would make the count and the list disagree, since the fold counts against the subject a
// record names rather than against whatever it is ultimately under.

export function CommentPage({
  comment,
  post,
  channel,
  onBack,
  backLabel,
  sidebar,
  rightSidebar,
  onHandleClick,
  onOpenComment,
}: {
  comment: PublishedComment
  /** The post this comment was made on. What locates the channel doc its counts live in,
   *  and what its own subject is matched against. */
  post: { channelID: string; publishedAt: string }
  /** The channel that published the post, for the line saying what this was said under. */
  channel: FeedChannel
  onBack: () => void
  backLabel: string
  sidebar: React.ReactNode
  rightSidebar: React.ReactNode
  onHandleClick?: (handle: string) => void
  onOpenComment?: (comment: PublishedComment) => void
}) {
  // What a reply is addressed at. The same shape the post's own thread is given, with the
  // comment named — which is the whole of what makes this a thread rather than a copy.
  const replyTarget: EndorsedItem = {
    channelID: post.channelID,
    publishedAt: post.publishedAt,
    // A comment has no content hash; its signature is what a version records.
    contentHash: comment.sig,
    comment: { actor: comment.actor, createdAt: comment.createdAt },
  }

  return (
    <div className="flex-1 p-6 lg:min-h-0">
      <div className="flex flex-col gap-6 lg:h-full lg:min-h-0 lg:flex-row lg:items-start">
        {sidebar}
        <div className="flex-1 space-y-6 min-w-0 lg:max-h-full lg:overflow-y-auto">
          {/* The comment in its own card and the replies in theirs, which is the shape a
              post's page has — the head of the thread is the thing, and what was said back
              to it sits beneath. Back lives in the FIRST card, as it does everywhere. */}
          <div className="border border-neutral-200 rounded-lg bg-white p-5 space-y-5">
            <button
              type="button"
              onClick={onBack}
              className="px-2.5 py-1 text-xs font-medium text-neutral-600 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
            >
              {backLabel}
            </button>

            {/* No `onOpen`: this row IS the thing, already open. */}
            <PostRow
              identity={{ kind: 'person', didDht: comment.actor }}
              at={comment.createdAt}
              onOpenPerson={onHandleClick}
            >
              <p className="text-xs text-neutral-500 truncate">
                Replying to {channel.name}
              </p>
              <RichBody
                body={comment.body ?? ''}
                facets={comment.facets}
                onHandleClick={onHandleClick}
              />
              <CommentFiles
                files={comment.attachments}
                comment={comment}
                post={post}
              />
              <CommentEngagementRow comment={comment} post={post} />
            </PostRow>
          </div>

          <CommentThread
            item={replyTarget}
            onHandleClick={onHandleClick}
            onOpenComment={onOpenComment}
          />
        </div>
        {rightSidebar}
      </div>
    </div>
  )
}
