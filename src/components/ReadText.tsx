import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useState } from 'react'
import { downloadItemBytes } from '../core/channels'
import type { ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'

export function ReadText({
  item,
  channelName,
  onBack,
}: {
  item: ItemRef
  channelName: string
  onBack: () => void
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sdk) return
    let cancelled = false
    setHtml(null)
    setError(null)
    downloadItemBytes(sdk, item.itemURL)
      .then((bytes) => {
        if (cancelled) return
        const text = new TextDecoder().decode(bytes)
        const rawHTML = marked.parse(text, { async: false }) as string
        setHtml(DOMPurify.sanitize(rawHTML))
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load item')
      })
    return () => {
      cancelled = true
    }
  }, [sdk, item.itemURL])

  return (
    <div className="flex-1 p-6">
      <article className="max-w-2xl mx-auto space-y-5">
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
        ) : html === null ? (
          <p className="text-neutral-500 text-sm">Loading…</p>
        ) : (
          <div
            className="markdown wrap-break-word"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via DOMPurify
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </article>
    </div>
  )
}
