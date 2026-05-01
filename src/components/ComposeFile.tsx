import { type ChangeEvent, useState } from 'react'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function ComposeFile({
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
  const [error, setError] = useState<string | null>(null)

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    if (!f) return
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
        type: 'file',
        title: trimmedTitle,
        mimeType: file.type || 'application/octet-stream',
        bytes: new Uint8Array(buf),
        filename: file.name,
      },
      channelIDs: [channel.channelID],
    })
    addToast(`Queued “${trimmedTitle}” for publish`)
    onQueued()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-neutral-500 text-sm">
        Any file. The catch-all for things outside the typed media formats.
      </p>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            File
          </span>
          <input
            type="file"
            onChange={handleFileChange}
            required
            className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer"
          />
        </label>

        {file && (
          <dl className="text-xs px-3 py-2 bg-neutral-50 rounded-lg border border-neutral-200 space-y-0.5">
            <div className="flex gap-2">
              <dt className="text-neutral-500 w-16 shrink-0">Filename</dt>
              <dd className="text-neutral-900 wrap-break-word">{file.name}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-neutral-500 w-16 shrink-0">Type</dt>
              <dd className="text-neutral-900">
                {file.type || 'application/octet-stream'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-neutral-500 w-16 shrink-0">Size</dt>
              <dd className="text-neutral-900">{formatBytes(file.size)}</dd>
            </div>
          </dl>
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
