import { useState } from 'react'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useComposeStore } from '../stores/compose'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'
import { PinIcon } from './PinIcon'

export function ComposePost({
  channel,
  onQueued,
  tabs,
}: {
  channel: OwnedChannel
  onQueued: () => void
  tabs?: React.ReactNode
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const enqueue = useUploadQueueStore((s) => s.enqueue)
  const addToast = useToastStore((s) => s.addToast)
  const armedItem = useComposeStore((s) => s.armedItem)
  const disarm = useComposeStore((s) => s.disarm)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPinned, setIsPinned] = useState(false)
  const canSubmit = !!title.trim() && !!body.trim()

  function insertArmedPinLink(ta: HTMLTextAreaElement) {
    if (!armedItem) return
    const pos = ta.selectionStart ?? body.length
    const link = armedItem.item.itemURL
    const next = body.slice(0, pos) + link + body.slice(ta.selectionEnd ?? pos)
    setBody(next)
    disarm()
    requestAnimationFrame(() => {
      ta.focus()
      const caret = pos + link.length
      ta.setSelectionRange(caret, caret)
    })
  }

  function handleBodyClick(e: React.MouseEvent<HTMLTextAreaElement>) {
    if (!armedItem) return
    insertArmedPinLink(e.currentTarget)
  }

  function handleBodyPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!armedItem) return
    e.preventDefault()
    insertArmedPinLink(e.currentTarget)
  }

  function pinAndSave() {
    if (!sdk) return
    const trimmedTitle = title.trim()
    const trimmedBody = body.trim()
    if (!trimmedTitle || !trimmedBody) return
    setError(null)
    setIsPinned(true)
    enqueue({
      payload: {
        type: 'text',
        title: trimmedTitle,
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode(trimmedBody),
      },
      channelIDs: [],
      destination: 'library',
    })
    addToast(`Queued “${trimmedTitle}” to pin`)
    setTimeout(() => onQueued(), 220)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk) return
    if (!agent || !agent.did) {
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
      <div className="flex items-center gap-2 flex-wrap">
        {tabs}
        <button
          type="button"
          onClick={pinAndSave}
          disabled={!canSubmit}
          title="Pin this post"
          aria-label="Pin this post"
          className="ml-auto p-1.5 rounded-full text-neutral-400 enabled:hover:text-green-600 enabled:hover:bg-green-50 enabled:cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <PinIcon
            className={`transition-colors ${
              isPinned ? 'fill-green-600 text-green-600' : ''
            }`}
          />
        </button>
      </div>
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
        onClick={handleBodyClick}
        onPaste={handleBodyPaste}
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
