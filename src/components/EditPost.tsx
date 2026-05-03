import { useEffect, useState } from 'react'
import { downloadItemBytes, editItem } from '../core/channels'
import type { ItemRef } from '../core/types'
import { type OwnedChannel, useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { useToastStore } from '../stores/toast'
import { FormCard } from './FormCard'

export function EditPost({
  item,
  channel,
  onCancel,
  onSaved,
  sidebar,
  rightSidebar,
}: {
  item: ItemRef
  channel: OwnedChannel
  onCancel: () => void
  onSaved: (newItem: ItemRef) => void
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const refreshChannel = useFeedStore((s) => s.refreshChannel)
  const addToast = useToastStore((s) => s.addToast)

  const [title, setTitle] = useState(item.title)
  const [body, setBody] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [bodyLoading, setBodyLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sdk) return
    let cancelled = false
    setBodyLoading(true)
    downloadItemBytes(sdk, item.itemURL)
      .then((bytes) => {
        if (cancelled) return
        setBody(new TextDecoder().decode(bytes))
        setBodyLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : 'Failed to load post body')
        setBodyLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sdk, item.itemURL])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sdk || !agent || submitting || bodyLoading) return
    const trimmedTitle = title.trim()
    const trimmedBody = body.trim()
    if (!trimmedTitle || !trimmedBody) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await editItem(sdk, agent, channel, item.id, {
        type: 'text',
        title: trimmedTitle,
        mimeType: 'text/markdown',
        bytes: new TextEncoder().encode(trimmedBody),
      })
      const sub = subscriptions.find((s) => s.channelID === channel.channelID)
      if (sub) await refreshChannel(sub)
      addToast(`Updated “${trimmedTitle}”`)
      onSaved(result.item)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
      setSubmitting(false)
    }
  }

  const card = (content: React.ReactNode) => (
    <FormCard
      sidebar={sidebar}
      rightSidebar={rightSidebar}
      onBack={onCancel}
    >
      {content}
    </FormCard>
  )

  if (loadError) {
    return card(
      <p className="text-red-600 text-sm wrap-break-word">{loadError}</p>,
    )
  }

  return card(
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-900">Edit post</h1>
        <p className="text-neutral-500 text-sm">
          Saving uploads new bytes to Sia and updates the manifest only on
          success. Subscribers who pinned the previous version keep their
          snapshot.
        </p>
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={submitting || bodyLoading}
        required
        placeholder="Title"
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
      />

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={submitting || bodyLoading}
        required
        rows={14}
        placeholder={bodyLoading ? 'Loading body…' : 'Markdown supported.'}
        className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500 font-mono"
      />

      {error && <p className="text-red-600 text-sm wrap-break-word">{error}</p>}

      {submitting && (
        <p className="text-neutral-500 text-xs">
          Uploading new bytes to Sia, then writing the manifest. The old
          version stays live until both succeed.
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || bodyLoading || !title.trim() || !body.trim()}
        className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
      >
        {submitting ? 'Saving…' : 'Save changes'}
      </button>
    </form>,
  )
}
