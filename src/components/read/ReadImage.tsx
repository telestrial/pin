import type { FeedEntry } from '../../core/feed'
import type { ItemRef } from '../../core/types'
import { useItemBlobURL } from '../../lib/hooks/useItemBytes'
import type { PinInput } from '../../stores/pin'
import { CommentThread } from '../engagement/CommentThread'
import { EngagementRow } from '../engagement/EngagementRow'

export function ReadImage({
  item,
  channelName,
  onBack,
  backLabel,
  sidebar,
  rightSidebar,
  pinInput,
  entry,
  onEdit,
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
  onEdit?: () => void
}) {
  const { url: imgURL, error } = useItemBlobURL(
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
            <div className="flex items-center gap-1.5">
              {onEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  className="px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
                >
                  Edit
                </button>
              )}
              <EngagementRow input={pinInput} entry={entry} />
            </div>
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
          ) : imgURL === null ? (
            <p className="text-neutral-500 text-sm">Loading…</p>
          ) : (
            <img
              src={imgURL}
              alt={item.title || 'image'}
              className="max-w-full rounded-lg border border-neutral-200 bg-neutral-50"
            />
          )}
        </article>
        {/* Under the post, and only on a channel that takes comments — the component
            decides that for itself, so every reader page asks the same way. */}
        <CommentThread
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
