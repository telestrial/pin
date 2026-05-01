import { useEffect, useState } from 'react'
import { downloadItemBytes } from '../core/channels'
import type { ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'

export function ReadAudio({
  item,
  channelName,
  onBack,
  sidebar,
}: {
  item: ItemRef
  channelName: string
  onBack: () => void
  sidebar: React.ReactNode
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const [audioURL, setAudioURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sdk) return
    let cancelled = false
    let createdURL: string | null = null
    setAudioURL(null)
    setError(null)
    downloadItemBytes(sdk, item.itemURL)
      .then((bytes) => {
        if (cancelled) return
        const blob = new Blob([bytes as BlobPart], { type: item.mimeType })
        createdURL = URL.createObjectURL(blob)
        setAudioURL(createdURL)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load audio')
      })
    return () => {
      cancelled = true
      if (createdURL) URL.revokeObjectURL(createdURL)
    }
  }, [sdk, item.itemURL, item.mimeType])

  return (
    <div className="flex-1 p-6">
      <div className="max-w-5xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <article className="flex-1 lg:max-w-2xl space-y-5 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors"
          >
            ← Back to feed
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

          {error ? (
            <p className="text-red-600 text-sm wrap-break-word">{error}</p>
          ) : audioURL === null ? (
            <p className="text-neutral-500 text-sm">Loading…</p>
          ) : (
            <audio src={audioURL} controls className="w-full">
              <track kind="captions" />
            </audio>
          )}
        </article>
      </div>
    </div>
  )
}
