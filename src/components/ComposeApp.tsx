import { type ChangeEvent, useEffect, useState } from 'react'
import { APP_SANDBOX } from '../lib/constants'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

export function ComposeApp({
  channel,
  onQueued,
}: {
  channel: OwnedChannel
  onQueued: () => void
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const enqueue = useUploadQueueStore((s) => s.enqueue)
  const addToast = useToastStore((s) => s.addToast)

  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewHTML, setPreviewHTML] = useState<string | null>(null)
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
    setError(null)
    const buf = await file.arrayBuffer()
    enqueue({
      payload: {
        type: 'app',
        title: trimmedTitle,
        mimeType: 'text/html',
        bytes: new Uint8Array(buf),
      },
      channelIDs: [channel.channelID],
    })
    addToast(`Queued “${trimmedTitle}” for publish`)
    onQueued()
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
            required
            className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer"
          />
        </label>

        {previewHTML !== null && (
          <iframe
            title="App preview"
            srcDoc={previewHTML}
            sandbox={APP_SANDBOX}
            allow="fullscreen"
            className="w-full aspect-4/3 rounded-lg border border-neutral-200 bg-white"
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
            required
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600"
          />
        </label>
      </div>

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      <button
        type="submit"
        disabled={!file || !title.trim()}
        className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
      >
        Publish
      </button>
    </form>
  )
}
