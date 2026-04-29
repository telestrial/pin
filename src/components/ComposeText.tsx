import { useState } from 'react'
import { publishTextItem } from '../core/publish'
import { useAuthStore, type OwnedChannel } from '../stores/auth'

export function ComposeText({
  channel,
  onCancel,
  onPublished,
}: {
  channel: OwnedChannel
  onCancel: () => void
  onPublished: (itemURL: string, title: string) => void
}) {
  const sdk = useAuthStore((s) => s.sdk)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk) return
    const trimmedTitle = title.trim()
    const trimmedBody = body.trim()
    if (!trimmedTitle || !trimmedBody) return
    setSubmitting(true)
    setError(null)
    try {
      const updated = await publishTextItem(
        sdk,
        channel.channelID,
        trimmedTitle,
        trimmedBody,
      )
      const newItem = updated.items[0]
      onPublished(newItem.itemURL, newItem.title)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to publish')
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-md mx-auto space-y-5 p-6"
    >
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-900">
          Publish to {channel.name}
        </h1>
        <p className="text-neutral-500 text-sm">
          A text item. Markdown is supported.
        </p>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Title
          </span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={submitting}
            required
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Body
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={submitting}
            required
            rows={10}
            placeholder="# Hello world&#10;&#10;Whatever you want to say."
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500 font-mono"
          />
        </label>
      </div>

      {error && (
        <p className="text-red-600 text-sm wrap-break-word">{error}</p>
      )}

      {submitting && (
        <p className="text-neutral-500 text-xs">
          Uploading item to Sia. ~20 seconds — every object pays a full slab of
          erasure-coded redundancy.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting || !title.trim() || !body.trim()}
          className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {submitting ? 'Publishing…' : 'Publish'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
