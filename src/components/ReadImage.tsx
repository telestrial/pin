import { useEffect, useState } from 'react'
import { downloadItemBytes } from '../core/channels'
import type { ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import type { PinInput } from '../stores/pin'
import { PinButton } from './PinButton'

export function ReadImage({
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
  const sdk = useAuthStore((s) => s.sdk)
  const [imgURL, setImgURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sdk) return
    let cancelled = false
    let createdURL: string | null = null
    setImgURL(null)
    setError(null)
    downloadItemBytes(sdk, item.itemURL)
      .then((bytes) => {
        if (cancelled) return
        const blob = new Blob([bytes as BlobPart], { type: item.mimeType })
        createdURL = URL.createObjectURL(blob)
        setImgURL(createdURL)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load image')
      })
    return () => {
      cancelled = true
      if (createdURL) URL.revokeObjectURL(createdURL)
    }
  }, [sdk, item.itemURL, item.mimeType])

  return (
    <div className="flex-1 p-6">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <article className="flex-1 xl:max-w-2xl min-w-0 bg-white border border-neutral-200 rounded-lg p-5 space-y-5">
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
        {rightSidebar}
      </div>
    </div>
  )
}
