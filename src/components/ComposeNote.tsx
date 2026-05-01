import { useState } from 'react'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

export function ComposeNote({
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

  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk) return
    if (!agent || !agent.session) {
      setError('Bluesky session not active. Cancel and try again to sign in.')
      return
    }
    const trimmedBody = body.trim()
    if (!trimmedBody) return
    setError(null)
    enqueue({
      payload: {
        type: 'text',
        title: '',
        summary: trimmedBody,
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode(trimmedBody),
      },
      channelIDs: [channel.channelID],
    })
    addToast('Queued for publish')
    onQueued()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-neutral-500 text-sm">
        A short note. Renders inline in the feed. Markdown is supported.
      </p>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
          Body
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          rows={5}
          placeholder="Whatever's on your mind."
          className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 font-mono"
        />
      </label>

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      <button
        type="submit"
        disabled={!body.trim()}
        className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
      >
        Publish
      </button>
    </form>
  )
}
