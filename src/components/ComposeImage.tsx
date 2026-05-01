import { type ChangeEvent, useEffect, useState } from 'react'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

const ACCEPTED_MIMES = ['image/jpeg', 'image/png', 'image/webp']

export function ComposeImage({
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
  const [previewURL, setPreviewURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setPreviewURL(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewURL(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    if (!f) return
    if (!ACCEPTED_MIMES.includes(f.type)) {
      setError(
        `Unsupported file type: ${f.type || 'unknown'}. Use JPEG, PNG, or WebP.`,
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
        type: 'image',
        title: trimmedTitle,
        mimeType: file.type,
        bytes: new Uint8Array(buf),
      },
      channelIDs: [channel.channelID],
    })
    addToast(`Queued “${trimmedTitle}” for publish`)
    onQueued()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-neutral-500 text-sm">An image. JPEG, PNG, or WebP.</p>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Image
          </span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
            required
            className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer"
          />
        </label>

        {previewURL && (
          <img
            src={previewURL}
            alt="preview"
            className="max-w-full max-h-80 rounded-lg border border-neutral-200 object-contain bg-neutral-50"
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
