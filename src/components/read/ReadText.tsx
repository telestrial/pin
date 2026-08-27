import { useMemo, useState } from 'react'
import type { FeedEntry } from '../../core/feed'
import type { ItemRef } from '../../core/types'
import type { PublishedComment } from '../../lib/channelConversations'
import { useItemBytes } from '../../lib/hooks/useItemBytes'
import { usePinState } from '../../lib/hooks/usePinState'
import { formatAbsolute, formatRelative } from '../../lib/time'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { type PinInput, usePinStore } from '../../stores/pin'
import { AttachmentGrid } from '../AttachmentMedia'
import { CommentThread } from '../engagement/CommentThread'
import { EngagementRow } from '../engagement/EngagementRow'
import { FilePinButton } from '../pin/FilePinButton'
import { RichBody } from '../RichBody'

export function ReadText({
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
  onHandleClick: (handle: string) => void
  /** Opening one comment's own page, where its replies are. */
  onOpenComment?: (comment: PublishedComment) => void
}) {
  const channelID = pinInput.channel.channelID
  const pinState = usePinState(item, channelID)
  const pinned = usePinStore((s) => s.pinned)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const entries = useFeedStore((s) => s.entries)
  // Look up the user's pin on this logical post. Used for both drift
  // (different contentHash) and retraction detection.
  const pinForThis = pinned.find(
    (p) =>
      p.channel.channelID === channelID &&
      p.item.publishedAt === item.publishedAt,
  )
  // Retraction: user has a pin, they subscribe to the channel (so the
  // manifest is in their feedStore), and the item is no longer in the
  // current entries — author dropped it via deletePublishedItem.
  // When retracted, the only available bytes are the pinned snapshot;
  // the channel-current that ReadText would normally render doesn't
  // exist anymore.
  const isSubscribed = subscriptions.some((s) => s.channelID === channelID)
  const inCurrentEntries = entries.some(
    (e) =>
      e.channel.channelID === channelID &&
      e.item.publishedAt === item.publishedAt,
  )
  const isRetracted = !!pinForThis && isSubscribed && !inCurrentEntries
  // Drift: pin's contentHash differs from rendered item's contentHash.
  // Toggle swaps the rendered version. Retraction forces yours-view
  // unconditionally (no current to switch to).
  const driftedPin = pinState === 'edited' ? pinForThis : undefined
  const [viewYours, setViewYours] = useState(false)
  const showYours = isRetracted || (viewYours && !!driftedPin)
  const displayItem = showYours && pinForThis ? pinForThis.item : item

  const { bytes, error } = useItemBytes(
    displayItem.itemURL,
    displayItem.contentHash,
  )
  const bodyText = useMemo(
    () => (bytes ? new TextDecoder().decode(bytes) : null),
    [bytes],
  )

  return (
    <div className="flex-1 p-6 lg:min-h-0">
      <div className="flex flex-col gap-6 lg:h-full lg:min-h-0 lg:flex-row lg:items-start">
        {sidebar}
        <div className="flex-1 min-w-0 space-y-6 lg:max-h-full lg:overflow-y-auto">
          <article className="bg-white border border-neutral-200 rounded-lg p-5 space-y-5">
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

            <header className="space-y-2">
              <p className="text-sm text-neutral-500">
                <span className="font-medium text-neutral-900">
                  {channelName}
                </span>{' '}
                · {formatRelative(displayItem.publishedAt)}
                {displayItem.editedAt && (
                  <span
                    title={`Edited ${formatAbsolute(displayItem.editedAt)}`}
                  >
                    {' · edited '}
                    {formatRelative(displayItem.editedAt)}
                  </span>
                )}
              </p>
              {displayItem.title && (
                <p className="text-base font-semibold text-neutral-900 wrap-break-word">
                  {displayItem.title}
                </p>
              )}
              {isRetracted ? (
                <p className="text-sm italic text-neutral-500">
                  This post was retracted by the author. You're viewing your
                  pinned copy.
                </p>
              ) : (
                driftedPin && (
                  <p className="text-sm text-neutral-500 flex items-center gap-2 flex-wrap">
                    {showYours ? (
                      <>
                        <span>Showing your pinned version.</span>
                        <button
                          type="button"
                          onClick={() => setViewYours(false)}
                          className="px-2 py-0.5 text-xs font-medium text-neutral-700 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
                        >
                          View current
                        </button>
                      </>
                    ) : (
                      <>
                        <span>You pinned an earlier version.</span>
                        <button
                          type="button"
                          onClick={() => setViewYours(true)}
                          className="px-2 py-0.5 text-xs font-medium text-neutral-700 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
                        >
                          View yours
                        </button>
                      </>
                    )}
                  </p>
                )
              )}
            </header>

            {error ? (
              <p className="text-red-600 text-sm wrap-break-word">{error}</p>
            ) : bodyText === null ? (
              <p className="text-neutral-500 text-sm">Loading…</p>
            ) : (
              // The same renderer a row uses, larger. This page hand-rolled it — the memo,
              // the sanitized HTML, the mention click delegation — which was a second copy
              // of RichBody that could drift from the one every other surface reads through.
              <RichBody
                body={bodyText}
                facets={displayItem.facets}
                onHandleClick={onHandleClick}
                textClass="text-base sm:text-lg"
              />
            )}

            {displayItem.attachments && displayItem.attachments.length > 0 && (
              <AttachmentGrid
                attachments={displayItem.attachments}
                pin={(a) => (
                  <FilePinButton
                    attachment={a}
                    channelID={channelID}
                    itemID={item.id}
                    publishedAt={item.publishedAt}
                  />
                )}
              />
            )}

            <footer className="pt-2 text-xs text-neutral-500">
              {formatAbsolute(displayItem.publishedAt)}
              {displayItem.editedAt && (
                <>
                  {' · edited '}
                  {formatAbsolute(displayItem.editedAt)}
                </>
              )}
            </footer>
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
        </div>
        {rightSidebar}
      </div>
    </div>
  )
}
