import { type ChangeEvent, useEffect, useState } from 'react'
import { APP_SANDBOX } from '../lib/constants'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

export function ComposeApp({
  channel,
  onQueued,
  initialFile,
}: {
  channel: OwnedChannel
  onQueued: () => void
  initialFile?: File | null
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const enqueue = useUploadQueueStore((s) => s.enqueue)
  const addToast = useToastStore((s) => s.addToast)

  const [title, setTitle] = useState(
    initialFile ? initialFile.name.replace(/\.[^.]+$/, '') : '',
  )
  const [file, setFile] = useState<File | null>(initialFile ?? null)
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
    addToast(
      trimmedTitle
        ? `Queued “${trimmedTitle}” for publish`
        : `Queued ${file.name} for publish`,
    )
    onQueued()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <input
        type="file"
        accept="text/html,.html,.htm"
        onChange={handleFileChange}
        disabled={!!file}
        className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
      />

      {previewHTML !== null && (
        <iframe
          title="App preview"
          srcDoc={previewHTML}
          sandbox={APP_SANDBOX}
          allow="fullscreen"
          className="w-full aspect-4/3 rounded-lg border border-neutral-200 bg-white"
        />
      )}

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600"
      />

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!file}
          className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-md transition-colors"
        >
          Publish
        </button>
      </div>
    </form>
  )
}
