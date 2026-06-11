import { useState } from 'react'
import { fetchChannel, parseSubscribeURL } from '../core/channels'
import type { FeedEntry } from '../core/feed'
import { flushSettingsBestEffort } from '../lib/useSettingsSync'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { FormCard } from './FormCard'

export function SubscribeToChannel({
  onCancel,
  onSubscribed,
  sidebar,
  rightSidebar,
}: {
  onCancel: () => void
  onSubscribed: (channelName: string) => void
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
}) {
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const addSubscription = useAuthStore((s) => s.addSubscription)

  const [url, setUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return

    setSubmitting(true)
    setError(null)
    try {
      const parsed = await parseSubscribeURL(trimmed)
      if (
        subscriptions.some(
          (s) =>
            s.authorHandle === parsed.authorHandle &&
            s.channelID === parsed.channelID,
        )
      ) {
        setError("You're already subscribed to this channel.")
        setSubmitting(false)
        return
      }
      const manifest = await fetchChannel(
        parsed.authorHandle,
        parsed.channelID,
        parsed.channelKey,
      )
      addSubscription({
        authorHandle: parsed.authorHandle,
        authorDID: manifest.authorATProtoDID,
        channelID: parsed.channelID,
        channelKey: parsed.channelKey,
        cachedName: manifest.name,
        label: manifest.name,
        addedAt: new Date().toISOString(),
      })

      // Populate feed entries from the manifest we already fetched. Without
      // this, existing items don't show until JetStream pushes a new commit
      // or the user hits Refresh.
      const fresh: FeedEntry[] = manifest.items.map((item) => ({
        item,
        channel: {
          authorHandle: parsed.authorHandle,
          channelID: parsed.channelID,
          name: manifest.name,
          avatar: manifest.avatar,
        },
      }))
      useFeedStore.setState((s) => ({
        entries: [...s.entries, ...fresh],
        manifests: { ...s.manifests, [parsed.channelID]: manifest },
      }))

      // Persist the new subscription to Sia settings before reporting done,
      // so a quick reload before the background debounce doesn't drop it.
      await flushSettingsBestEffort()
      onSubscribed(manifest.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch channel')
      setSubmitting(false)
    }
  }

  return (
    <FormCard
      sidebar={sidebar}
      rightSidebar={rightSidebar}
      onBack={onCancel}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-neutral-900">
          Subscribe to a channel
        </h1>
        <p className="text-neutral-500 text-sm">
          Paste a Pin subscribe URL. The URL contains the author's handle, the
          channel handle, and the decryption key.
        </p>
      </div>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
          Subscribe URL
        </span>
        <textarea
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={submitting}
          required
          rows={3}
          placeholder="pin://author.bsky.social#k=..."
          className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-[11px] font-mono text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600 disabled:bg-neutral-50 disabled:text-neutral-500"
        />
      </label>

      {error && (
        <p className="text-red-600 text-sm wrap-break-word">{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting || !url.trim()}
        className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {submitting ? 'Subscribing…' : 'Subscribe'}
      </button>
      </form>
    </FormCard>
  )
}
