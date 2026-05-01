import { useMemo } from 'react'
import type { FeedEntry } from '../core/feed'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { ChannelAvatar } from './ChannelAvatar'
import {
  availableFiltersFor,
  entryFilter,
  FILTER_LABEL,
  FilterPills,
  type TypeFilter,
} from './FilterPills'
import { FeedRow } from './HomeFeed'

export function ChannelView({
  authorHandle,
  channelID,
  filter,
  onFilterChange,
  onItemClick,
  onChannelClick,
  onBack,
}: {
  authorHandle: string
  channelID: string
  filter: TypeFilter
  onFilterChange: (filter: TypeFilter) => void
  onItemClick: (entry: FeedEntry) => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  onBack: () => void
}) {
  const sub = useAuthStore((s) =>
    s.subscriptions.find(
      (x) => x.authorHandle === authorHandle && x.channelID === channelID,
    ),
  )
  const sortOrder = useAuthStore((s) => s.feedSortOrder)
  const setSortOrder = useAuthStore((s) => s.setFeedSortOrder)
  const entries = useFeedStore((s) => s.entries)
  const loading = useFeedStore((s) => s.loading)
  const live = useFeedStore((s) => s.live)
  const refreshChannel = useFeedStore((s) => s.refreshChannel)

  const channelEntries = useMemo(() => {
    const filtered = entries.filter(
      (e) =>
        e.channel.authorHandle === authorHandle &&
        e.channel.channelID === channelID,
    )
    filtered.sort((a, b) => {
      const cmp = a.item.publishedAt.localeCompare(b.item.publishedAt)
      return sortOrder === 'oldest' ? cmp : -cmp
    })
    return filtered
  }, [entries, authorHandle, channelID, sortOrder])

  const availableFilters = useMemo(
    () => availableFiltersFor(channelEntries),
    [channelEntries],
  )

  const displayedEntries = useMemo(() => {
    if (filter === 'all') return channelEntries
    return channelEntries.filter((e) => entryFilter(e) === filter)
  }, [channelEntries, filter])

  const channelName =
    sub?.cachedName ?? channelEntries[0]?.channel.name ?? channelID
  const coverArt = channelEntries[0]?.channel.coverArt

  return (
    <div className="flex-1 p-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-neutral-500 hover:text-neutral-900 transition-colors cursor-pointer"
        >
          ← Back
        </button>

        <div className="border border-neutral-200 rounded-lg bg-white p-5 flex items-center gap-5">
          <ChannelAvatar
            channelID={channelID}
            channelName={channelName}
            authorHandle={authorHandle}
            coverArt={coverArt}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-neutral-900 truncate">
              {channelName}
            </h1>
            <p className="text-sm text-neutral-500 truncate">@{authorHandle}</p>
            <p className="text-xs text-neutral-500 mt-1">
              {channelEntries.length} item
              {channelEntries.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        <div className="border border-neutral-200 rounded-lg bg-white p-4 space-y-4">
          <FilterPills
            available={availableFilters}
            filter={filter}
            onFilterChange={onFilterChange}
          />
          <div className="flex items-center justify-between gap-3">
            <div
              className="flex gap-0.5 bg-neutral-100 rounded-md p-0.5"
              role="tablist"
              aria-label="Sort items"
            >
              {(['newest', 'oldest'] as const).map((order) => {
                const active = sortOrder === order
                return (
                  <button
                    key={order}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSortOrder(order)}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                      active
                        ? 'bg-white text-neutral-900 shadow-sm'
                        : 'text-neutral-600 hover:text-neutral-900'
                    }`}
                  >
                    {order === 'newest' ? 'Newest' : 'Oldest'}
                  </button>
                )
              })}
            </div>
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              {live ? (
                <span className="hidden sm:inline-flex items-center gap-1.5">
                  <span className="relative flex size-1.5">
                    <span className="animate-ping absolute inline-flex size-full rounded-full bg-green-500 opacity-75" />
                    <span className="relative inline-flex rounded-full size-1.5 bg-green-600" />
                  </span>
                  Live
                </span>
              ) : (
                <span className="hidden sm:inline-flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-neutral-400" />
                  Offline
                </span>
              )}
              <button
                type="button"
                onClick={() => sub && refreshChannel(sub)}
                disabled={loading || !sub}
                className="relative px-2.5 py-1 text-xs font-medium text-neutral-700 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors disabled:opacity-50 cursor-pointer"
              >
                <span className={loading ? 'invisible' : ''}>Refresh</span>
                {loading && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="size-3 border-2 border-neutral-300 border-t-neutral-700 rounded-full animate-spin" />
                  </span>
                )}
              </button>
            </div>
          </div>

          {displayedEntries.length === 0 ? (
            <p className="text-neutral-500 text-sm">
              {filter === 'all'
                ? 'No items yet.'
                : `No ${FILTER_LABEL[filter].toLowerCase()} yet.`}
            </p>
          ) : (
            <ul className="divide-y divide-neutral-200/80">
              {displayedEntries.map((entry) => (
                <FeedRow
                  key={entry.item.id}
                  entry={entry}
                  onItemClick={onItemClick}
                  onChannelClick={onChannelClick}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
