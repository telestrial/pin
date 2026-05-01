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
        onChange={handleFileChange}
        disabled={!!file}
        className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer disabled:opacity-50"
      />

      {file && (
        <p className="text-xs text-neutral-500 truncate">
          {file.name} · {file.type || 'application/octet-stream'} ·{' '}
          {formatBytes(file.size)}
        </p>
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
