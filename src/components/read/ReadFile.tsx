import { useEffect, useRef, useState } from 'react'
import { downloadItemBytes } from '../../core/channels'
import type { FeedEntry } from '../../core/feed'
import type { ItemRef } from '../../core/types'
import type { PublishedComment } from '../../lib/channelConversations'
import { formatBytes } from '../../lib/format'
import { useAuthStore } from '../../stores/auth'
import type { PinInput } from '../../stores/pin'
import { CommentThread } from '../engagement/CommentThread'
import { EngagementRow } from '../engagement/EngagementRow'

export function ReadFile({
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
  const client = useAuthStore((s) => s.client)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blobURLRef = useRef<string | null>(null)

  const filename = item.filename ?? `${item.title || 'download'}.bin`

  useEffect(() => {
    return () => {
      if (blobURLRef.current) URL.revokeObjectURL(blobURLRef.current)
    }
  }, [])

  async function handleDownload() {
    if (!client || downloading) return
    setError(null)
    setDownloading(true)
    try {
      const bytes = await downloadItemBytes(client, item.itemURL)
      const blob = new Blob([bytes as BlobPart], {
        type: item.mimeType || 'application/octet-stream',
      })
      if (blobURLRef.current) URL.revokeObjectURL(blobURLRef.current)
      const url = URL.createObjectURL(blob)
      blobURLRef.current = url
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to download')
    } finally {
      setDownloading(false)
    }
  }

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
              <EngagementRow input={pinInput} entry={entry} />
            </div>

            <header className="space-y-1">
              <h1 className="text-2xl font-semibold text-neutral-900 wrap-break-word">
                {item.title || filename}
              </h1>
              <p className="text-xs text-neutral-500">
                {channelName} ·{' '}
                {new Date(item.publishedAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            </header>

            <div className="px-4 py-4 bg-neutral-50 rounded-lg border border-neutral-200 space-y-4">
              <dl className="text-sm space-y-1">
                <div className="flex gap-3">
                  <dt className="text-neutral-500 w-20 shrink-0">Filename</dt>
                  <dd className="text-neutral-900 wrap-break-word">
                    {filename}
                  </dd>
                </div>
                <div className="flex gap-3">
                  <dt className="text-neutral-500 w-20 shrink-0">Type</dt>
                  <dd className="text-neutral-900 wrap-break-word">
                    {item.mimeType || 'application/octet-stream'}
                  </dd>
                </div>
                <div className="flex gap-3">
                  <dt className="text-neutral-500 w-20 shrink-0">Size</dt>
                  <dd className="text-neutral-900">
                    {formatBytes(item.byteSize)}
                  </dd>
                </div>
              </dl>

              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading}
                className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {downloading ? 'Downloading from Sia…' : 'Download'}
              </button>

              {error && (
                <p className="text-red-600 text-sm wrap-break-word">{error}</p>
              )}
            </div>
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
