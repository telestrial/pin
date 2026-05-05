import { Pin } from 'lucide-react'
import { useState } from 'react'
import { NOTE_CHAR_LIMIT } from '../lib/constants'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

export function ComposeNote({
  channel,
  channels,
  hideChannel = false,
  onChannelChange,
  onQueued,
}: {
  channel: OwnedChannel
  channels: OwnedChannel[]
  hideChannel?: boolean
  onChannelChange: (channelID: string) => void
  onQueued: () => void
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const enqueue = useUploadQueueStore((s) => s.enqueue)
  const addToast = useToastStore((s) => s.addToast)

  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPinned, setIsPinned] = useState(false)

  const trimmed = body.trim()
  const remaining = NOTE_CHAR_LIMIT - body.length
  const overLimit = remaining < 0
  const canSubmit = !!trimmed && !overLimit

  function pinAndSave() {
    if (!sdk || !canSubmit) return
    setError(null)
    setIsPinned(true)
    enqueue({
      payload: {
        type: 'text',
        title: '',
        summary: trimmed,
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode(trimmed),
      },
      channelIDs: [],
      destination: 'library',
    })
    addToast('Queued to pin')
    // Brief beat so the filled pin is visible before the form clears.
    // onQueued bumps the parent's resetCounter, which re-keys this
    // component and resets state — including isPinned — back to default.
    setTimeout(() => onQueued(), 220)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !canSubmit) return
    if (!agent || !agent.did) {
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
      <div className="flex justify-end">
        <button
          type="button"
          onClick={pinAndSave}
          disabled={!canSubmit}
          title="Pin this post"
          aria-label="Pin this post"
          className="p-1.5 rounded-full text-neutral-400 enabled:hover:text-green-600 enabled:hover:bg-green-50 enabled:cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <Pin
            className={`size-4 transition-colors ${
              isPinned ? 'fill-green-600 text-green-600' : ''
            }`}
          />
        </button>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required
        rows={3}
        placeholder="Whatever's on your mind."
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 font-mono"
      />

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      <div className="flex items-center justify-end gap-2">
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
        {!hideChannel &&
          (channels.length > 1 ? (
            <select
              value={channel.channelID}
              onChange={(e) => onChannelChange(e.target.value)}
              aria-label="Channel to post to"
              className="text-xs font-medium text-neutral-900 bg-neutral-100 hover:bg-neutral-200 border-0 rounded px-2 py-1 cursor-pointer focus:outline-none focus:ring-2 focus:ring-green-600 focus:ring-offset-1"
            >
              {channels.map((c) => (
                <option key={c.channelID} value={c.channelID}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs font-medium text-neutral-900 px-2 py-1 bg-neutral-50 rounded">
              {channel.name}
            </span>
          ))}
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
