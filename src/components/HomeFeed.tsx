import { useEffect } from 'react'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffSec = Math.floor((now - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export function HomeFeed() {
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const entries = useFeedStore((s) => s.entries)
  const errors = useFeedStore((s) => s.errors)
  const loading = useFeedStore((s) => s.loading)
  const lastRefreshedAt = useFeedStore((s) => s.lastRefreshedAt)
  const refresh = useFeedStore((s) => s.refresh)

  useEffect(() => {
    if (lastRefreshedAt === null) {
      refresh(subscriptions)
    }
  }, [lastRefreshedAt, refresh, subscriptions])

  if (loading && entries.length === 0 && errors.length === 0) {
    return <p className="text-neutral-500 text-sm">Loading feed…</p>
  }

  return (
    <div className="space-y-4">
      {errors.length > 0 && (
        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-800 text-xs space-y-1">
          <p className="font-medium">
            {errors.length} channel{errors.length === 1 ? '' : 's'} failed to
            load
          </p>
          <ul className="space-y-0.5">
            {errors.map((e) => (
              <li
                key={`${e.authorHandle}/${e.channelID}`}
                className="wrap-break-word"
              >
                {e.label || `${e.authorHandle}/${e.channelID}`}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {entries.length > 0 ? (
        <ul className="divide-y divide-neutral-200/80">
          {entries.map(({ item, channel }) => (
            <li key={item.id} className="py-3 space-y-1">
              <p className="text-sm text-neutral-900">{item.title}</p>
              {item.summary && (
                <p className="text-sm text-neutral-600">{item.summary}</p>
              )}
              <p className="text-xs text-neutral-500">
                {channel.name} · {formatRelative(item.publishedAt)} ·{' '}
                {item.type}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-neutral-500 text-sm">
          No items yet from your subscriptions.
        </p>
      )}

      <div className="flex items-center gap-3 text-xs text-neutral-500">
        <button
          type="button"
          onClick={() => refresh(subscriptions)}
          disabled={loading}
          className="text-neutral-500 hover:text-neutral-900 transition-colors underline underline-offset-2 disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        {lastRefreshedAt && (
          <span>Last refreshed {formatRelative(lastRefreshedAt)}</span>
        )}
      </div>
    </div>
  )
}
