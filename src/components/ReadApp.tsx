import { useEffect, useRef, useState } from 'react'
import { downloadItemBytes } from '../core/channels'
import type { ItemRef } from '../core/types'
import { installAppBridge } from '../lib/appBridge'
import { APP_SANDBOX } from '../lib/constants'
import { useAuthStore } from '../stores/auth'

export function ReadApp({
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
  const iframeRef = useRef<HTMLIFrameElement>(null)
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
        setHtml(new TextDecoder().decode(bytes))
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load app')
      })
    return () => {
      cancelled = true
    }
  }, [sdk, item.itemURL])

  useEffect(() => {
    return installAppBridge(() => iframeRef.current, item.id)
  }, [item.id])

  function enterFullscreen() {
    iframeRef.current?.requestFullscreen?.()
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

          {error ? (
            <p className="text-red-600 text-sm wrap-break-word">{error}</p>
          ) : html === null ? (
            <p className="text-neutral-500 text-sm">Loading…</p>
          ) : (
            <div className="space-y-2">
              <iframe
                ref={iframeRef}
                title={item.title}
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
      </div>
    </div>
  )
}
