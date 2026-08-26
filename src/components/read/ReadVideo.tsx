import type { FeedEntry } from '../../core/feed'
import type { ItemRef } from '../../core/types'
import type { PublishedComment } from '../../lib/channelConversations'
import { useItemBlobURL } from '../../lib/hooks/useItemBytes'
import type { PinInput } from '../../stores/pin'
import { CommentThread } from '../engagement/CommentThread'
import { EngagementRow } from '../engagement/EngagementRow'

export function ReadVideo({
  item,
  channelName,
  onBack,
  backLabel,
  sidebar,
  rightSidebar,
  pinInput,
  entry,
  onHandleClick,
  onOpenComment,
}: {
  item: ItemRef
  channelName: string
  onBack: () => void
  backLabel: string
  sidebar: React.ReactNode
  rightSidebar: React.ReactNode
  pinInput: PinInput
  // The feed entry this page was opened from, when there was one. Carries what
  // the pin input does not: whether the post can be circulated, and by whom.
  entry?: FeedEntry
  /** Opening whoever wrote a comment: a commenter is a person, not a channel. */
  onHandleClick?: (handle: string) => void
  /** Opening one comment's own page, where its replies are. */
  onOpenComment?: (comment: PublishedComment) => void
}) {
  const { url: videoURL, error } = useItemBlobURL(
    item.itemURL,
    item.mimeType,
    item.contentHash,
  )

  return (
    <div className="flex-1 p-6 lg:min-h-0">
      <div className="flex flex-col gap-6 lg:h-full lg:min-h-0 lg:flex-row lg:items-start">
        {sidebar}
        <article className="flex-1 min-w-0 bg-white border border-neutral-200 rounded-lg p-5 space-y-5 lg:max-h-full lg:overflow-y-auto">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
            >
              {backLabel}
            </button>
            <EngagementRow input={pinInput} entry={entry} />
          </div>

          <header className="space-y-1">
            {item.title && (
              <h1 className="text-2xl font-semibold text-neutral-900 wrap-break-word">
                {item.title}
              </h1>
            )}
            <p className="text-xs text-neutral-500">
              {channelName} ·{' '}
              {new Date(item.publishedAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>
          </header>

          {error ? (
            <p className="text-red-600 text-sm wrap-break-word">{error}</p>
          ) : videoURL === null ? (
            <p className="text-neutral-500 text-sm">Loading…</p>
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: user-uploaded video has no caption track to provide
            <video
              src={videoURL}
              controls
              className="w-full rounded-lg border border-neutral-200 bg-black"
            />
          )}
        </article>
        {/* Under the post, and only on a channel that takes comments — the component
            decides that for itself, so every reader page asks the same way. */}
        <CommentThread
          onHandleClick={onHandleClick}
          onOpenComment={onOpenComment}
          item={{
            channelID: pinInput.channel.channelID,
            publishedAt: item.publishedAt,
            contentHash: item.contentHash,
          }}
        />
        {rightSidebar}
      </div>
    </div>
  )
}
