import { type ChangeEvent, useEffect, useState } from 'react'
import { publishItem } from '../core/channels'
import { WEBAPP_SANDBOX } from '../lib/constants'
import { type OwnedChannel, useAuthStore } from '../stores/auth'

export function ComposeWebapp({
  channel,
  onCancel,
  onPublished,
}: {
  channel: OwnedChannel
  onCancel: () => void
  onPublished: (itemURL: string, title: string) => void
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)

  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewHTML, setPreviewHTML] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setPreviewHTML(null)
      return
    }
    let cancelled = false
    file.text().then((text) => {
      if (!cancelled) setPreviewHTML(text)
    })
    return () => {
      cancelled = true
    }
  }, [file])

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    if (!f) return
    // Windows often reports empty MIME for .html files; fall back to extension.
    const name = f.name.toLowerCase()
    const isHTML =
      f.type === 'text/html' || name.endsWith('.html') || name.endsWith('.htm')
    if (!isHTML) {
      setError(
        `Unsupported file type: ${f.type || 'unknown'}. Use a .html file.`,
      )
      setFile(null)
      return
    }
    setError(null)
    setFile(f)
    if (!title.trim()) {
      setTitle(f.name.replace(/\.[^.]+$/, ''))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !file) return
    if (!agent || !agent.session) {
      setError('Bluesky session not active. Cancel and try again to sign in.')
      return
    }
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    setSubmitting(true)
    setError(null)
    try {
      const buf = await file.arrayBuffer()
      const result = await publishItem(
        sdk,
        agent,
        { channelID: channel.channelID, channelKey: channel.channelKey },
        {
          type: 'webapp',
          title: trimmedTitle,
          mimeType: 'text/html',
          bytes: new Uint8Array(buf),
        },
      )
      onPublished(result.itemRef.itemURL, result.itemRef.title)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to publish')
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-neutral-500 text-sm">
        A self-contained .html file. Inline JS and CSS run in a sandboxed
        iframe.
      </p>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            HTML file
          </span>
          <input
            type="file"
            accept="text/html,.html,.htm"
            onChange={handleFileChange}
            disabled={submitting}
            required
            className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
          />
        </label>

        {previewHTML !== null && (
          <iframe
            title="Webapp preview"
            srcDoc={previewHTML}
            sandbox={WEBAPP_SANDBOX}
            className="w-full aspect-[4/3] rounded-lg border border-neutral-200 bg-white"
          />
        )}

        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Title
          </span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={submitting}
            required
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
          />
        </label>
      </div>

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      {submitting && (
        <p className="text-neutral-500 text-xs">
          Uploading webapp to Sia. Larger HTML files take longer — every object
          pays a full slab of erasure-coded redundancy.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting || !file || !title.trim()}
          className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {submitting ? 'Publishing…' : 'Publish'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
