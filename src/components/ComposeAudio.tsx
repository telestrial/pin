import { type ChangeEvent, useEffect, useState } from 'react'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

const ACCEPTED_MIMES = ['audio/mpeg', 'audio/mp4', 'audio/x-m4a']

export function ComposeAudio({
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
      setError(`Unsupported file type: ${f.type || 'unknown'}. Use MP3 or M4A.`)
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
        type: 'audio',
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
    <form onSubmit={handleSubmit} className="space-y-2">
      <input
        type="file"
        accept="audio/mpeg,audio/mp4,audio/x-m4a,.mp3,.m4a"
        onChange={handleFileChange}
        required
        className="block w-full text-sm text-neutral-700 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 file:text-neutral-900 hover:file:bg-neutral-200 file:cursor-pointer"
      />

      {previewURL && (
        <audio src={previewURL} controls className="w-full" preload="metadata">
          <track kind="captions" />
        </audio>
      )}

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
        placeholder="Title"
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600"
      />

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!file || !title.trim()}
          className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-md transition-colors"
        >
          Publish
        </button>
      </div>
    </form>
  )
}
