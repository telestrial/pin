import { useEffect, useMemo } from 'react'
import type { FeedEntry } from '../core/feed'
import { renderMarkdown } from '../lib/markdown'
import { formatRelative } from '../lib/time'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'

export function HomeFeed({
  onItemClick,
}: {
  onItemClick: (entry: FeedEntry) => void
}) {
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
    return (
      <div className="border border-neutral-200 rounded-lg bg-white p-4">
        <p className="text-neutral-500 text-sm">Loading feed…</p>
      </div>
    )
  }

  return (
    <div className="border border-neutral-200 rounded-lg bg-white p-4 space-y-4">
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
          {entries.map((entry) => (
            <FeedRow
              key={entry.item.id}
              entry={entry}
              onItemClick={onItemClick}
            />
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

function FeedRow({
  entry,
  onItemClick,
}: {
  entry: FeedEntry
  onItemClick: (entry: FeedEntry) => void
}) {
  const { item, channel } = entry
  const isNote = item.title === ''

  const noteHTML = useMemo(
    () => (isNote ? renderMarkdown(item.summary ?? '') : null),
    [isNote, item.summary],
  )

  const meta = (
    <p className="text-xs text-neutral-500">
      {channel.name} · {formatRelative(item.publishedAt)}
      {!isNote && ` · ${item.type}`}
    </p>
  )

  if (isNote) {
    return (
      <li>
        <div className="py-3 space-y-1 px-2 -mx-2">
          <div
            className="markdown wrap-break-word text-sm text-neutral-900"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via DOMPurify
            dangerouslySetInnerHTML={{ __html: noteHTML ?? '' }}
          />
          {meta}
        </div>
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onItemClick(entry)}
        className="w-full text-left py-3 space-y-1 hover:bg-neutral-50 cursor-pointer px-2 -mx-2 rounded transition-colors"
      >
        <p className="text-sm text-neutral-900">{item.title}</p>
        {item.summary && (
          <p className="text-sm text-neutral-600">{item.summary}</p>
        )}
        {meta}
      </button>
    </li>
  )
}
