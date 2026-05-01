import { useEffect, useState } from 'react'
import { downloadItemBytes } from '../core/channels'
import type { ItemRef } from '../core/types'
import { renderMarkdown } from '../lib/markdown'
import { formatAbsolute, formatRelative } from '../lib/time'
import { useAuthStore } from '../stores/auth'

export function ReadText({
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
        setHtml(renderMarkdown(text))
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

          <header className="space-y-2">
            <p className="text-sm text-neutral-500">
              <span className="font-medium text-neutral-900">
                {channelName}
              </span>{' '}
              · {formatRelative(item.publishedAt)}
            </p>
            {item.title && (
              <p className="text-base font-semibold text-neutral-900 wrap-break-word">
                {item.title}
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

          <footer className="pt-2 text-xs text-neutral-500">
            {formatAbsolute(item.publishedAt)}
          </footer>
        </article>
      </div>
    </div>
  )
}
