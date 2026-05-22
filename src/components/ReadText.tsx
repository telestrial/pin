import { useMemo, useState } from 'react'
import type { ItemRef } from '../core/types'
import { renderMarkdown } from '../lib/markdown'
import { formatAbsolute, formatRelative } from '../lib/time'
import { useItemBytes } from '../lib/useItemBytes'
import { usePinState } from '../lib/usePinState'
import { type PinInput, usePinStore } from '../stores/pin'
import { AttachmentGrid } from './AttachmentMedia'
import { PinButton } from './PinButton'

export function ReadText({
  item,
  channelName,
  onBack,
  backLabel,
  sidebar,
  rightSidebar,
  pinInput,
  onEdit,
}: {
  item: ItemRef
  channelName: string
  onBack: () => void
  backLabel: string
  sidebar: React.ReactNode
  rightSidebar: React.ReactNode
  pinInput: PinInput
  onEdit?: () => void
}) {
  const channelID = pinInput.channel.channelID
  const pinState = usePinState(item, channelID)
  const pinned = usePinStore((s) => s.pinned)
  // Drift means: contentHash on the rendered item differs from the
  // pinned snapshot. The toggle swaps between channel-current
  // (default) and the user's pinned bytes — different itemURL,
  // different contentHash, different attachments, possibly different
  // editedAt (yours has none if your pin pre-dates any edit).
  const driftedPin =
    pinState === 'edited'
      ? pinned.find(
          (p) =>
            p.channel.channelID === channelID &&
            p.item.publishedAt === item.publishedAt,
        )
      : undefined
  const [viewYours, setViewYours] = useState(false)
  const showYours = viewYours && !!driftedPin
  const displayItem = showYours && driftedPin ? driftedPin.item : item

  const { bytes, error } = useItemBytes(
    displayItem.itemURL,
    displayItem.contentHash,
  )
  const html = useMemo(
    () => (bytes ? renderMarkdown(new TextDecoder().decode(bytes)) : null),
    [bytes],
  )

  return (
    <div className="flex-1 p-6">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <article className="flex-1 min-w-0 bg-white border border-neutral-200 rounded-lg p-5 space-y-5">
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
              <PinButton input={pinInput} />
            </div>
          </div>

          <header className="space-y-2">
            <p className="text-sm text-neutral-500">
              <span className="font-medium text-neutral-900">
                {channelName}
              </span>{' '}
              · {formatRelative(displayItem.publishedAt)}
              {displayItem.editedAt && (
                <span title={`Edited ${formatAbsolute(displayItem.editedAt)}`}>
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
            {driftedPin && (
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
            )}
          </header>

          {error ? (
            <p className="text-red-600 text-sm wrap-break-word">{error}</p>
          ) : html === null ? (
            <p className="text-neutral-500 text-sm">Loading…</p>
          ) : (
            <div
              className="markdown wrap-break-word text-base sm:text-lg"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via DOMPurify
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          {displayItem.attachments && displayItem.attachments.length > 0 && (
            <AttachmentGrid attachments={displayItem.attachments} />
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
        {rightSidebar}
      </div>
    </div>
  )
}
