import { useEffect, useRef, useState } from 'react'
import { downloadItemBytes } from '../core/channels'
import type { ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function ReadFile({
  item,
  channelName,
  onBack,
  backLabel,
  sidebar,
}: {
  item: ItemRef
  channelName: string
  onBack: () => void
  backLabel: string
  sidebar: React.ReactNode
}) {
  const sdk = useAuthStore((s) => s.sdk)
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
    if (!sdk || downloading) return
    setError(null)
    setDownloading(true)
    try {
      const bytes = await downloadItemBytes(sdk, item.itemURL)
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
    <div className="flex-1 p-6">
      <div className="max-w-5xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <article className="flex-1 lg:max-w-2xl min-w-0 bg-white border border-neutral-200 rounded-lg p-5 space-y-5">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
          >
            {backLabel}
          </button>

          <header className="space-y-1">
            <h1 className="text-2xl font-semibold text-neutral-900 wrap-break-word">
              {item.title}
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
                <dd className="text-neutral-900 wrap-break-word">{filename}</dd>
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
      </div>
    </div>
  )
}
