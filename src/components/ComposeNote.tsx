import { useState } from 'react'
import { NOTE_CHAR_LIMIT } from '../lib/constants'
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

  const trimmed = body.trim()
  const remaining = NOTE_CHAR_LIMIT - body.length
  const overLimit = remaining < 0
  const canSubmit = !!trimmed && !overLimit

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !canSubmit) return
    if (!agent || !agent.session) {
      setError('Bluesky session not active. Cancel and try again to sign in.')
      return
    }
    setError(null)
    enqueue({
      payload: {
        type: 'text',
        title: '',
        summary: trimmed,
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode(trimmed),
      },
      channelIDs: [channel.channelID],
    })
    addToast('Queued for publish')
    onQueued()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required
        rows={3}
        placeholder="Whatever's on your mind."
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 font-mono"
      />

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-xs tabular-nums ${
            overLimit
              ? 'text-red-600 font-medium'
              : remaining <= 20
                ? 'text-amber-600'
                : 'text-neutral-500'
          }`}
        >
          {remaining}
        </span>
        <button
          type="submit"
          disabled={!canSubmit}
          className="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-md transition-colors"
        >
          Publish
        </button>
      </div>
    </form>
  )
}
