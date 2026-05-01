import { useState } from 'react'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

export function ComposePost({
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
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk) return
    if (!agent || !agent.session) {
      setError('Bluesky session not active. Cancel and try again to sign in.')
      return
    }
    const trimmedTitle = title.trim()
    const trimmedBody = body.trim()
    if (!trimmedTitle || !trimmedBody) return
    setError(null)
    enqueue({
      payload: {
        type: 'text',
        title: trimmedTitle,
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode(trimmedBody),
      },
      channelIDs: [channel.channelID],
    })
    addToast(`Queued “${trimmedTitle}” for publish`)
    onQueued()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
        placeholder="Title"
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required
        rows={6}
        placeholder="# Hello world&#10;&#10;Markdown supported."
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 font-mono"
      />

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!title.trim() || !body.trim()}
          className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-md transition-colors"
        >
          Publish
        </button>
      </div>
    </form>
  )
}
