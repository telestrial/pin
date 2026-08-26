import { useEffect, useMemo, useRef } from 'react'
import type { FeedEntry } from '../../core/feed'
import type { ItemRef } from '../../core/types'
import { installAppBridge } from '../../lib/appBridge'
import type { PublishedComment } from '../../lib/channelConversations'
import { APP_SANDBOX } from '../../lib/constants'
import { useItemBytes } from '../../lib/hooks/useItemBytes'
import type { PinInput } from '../../stores/pin'
import { CommentThread } from '../engagement/CommentThread'
import { EngagementRow } from '../engagement/EngagementRow'

export function ReadApp({
  item,
  channelName,
  onBack,
  backLabel,
  sidebar,
  rightSidebar,
  pinInput,
  entry,
  onEdit,
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
  onEdit?: () => void
  /** Opening whoever wrote a comment: a commenter is a person, not a channel. */
  onHandleClick?: (handle: string) => void
  /** Opening one comment's own page, where its replies are. */
  onOpenComment?: (comment: PublishedComment) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const { bytes, error } = useItemBytes(item.itemURL, item.contentHash)
  const html = useMemo(
    () => (bytes ? new TextDecoder().decode(bytes) : null),
    [bytes],
  )

  useEffect(() => {
    return installAppBridge(() => iframeRef.current, item.id)
  }, [item.id])

  function enterFullscreen() {
    iframeRef.current?.requestFullscreen?.()
  }

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
          ) : html === null ? (
            <p className="text-neutral-500 text-sm">Loading…</p>
          ) : (
            <div className="space-y-2">
              <iframe
                ref={iframeRef}
                title={item.title || 'app'}
                srcDoc={html}
                sandbox={APP_SANDBOX}
                allow="fullscreen"
                className="w-full aspect-4/3 rounded-lg border border-neutral-200 bg-white"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={enterFullscreen}
                  className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors underline underline-offset-2"
                >
                  Fullscreen
                </button>
              </div>
            </div>
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
