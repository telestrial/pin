import { useEffect, useMemo } from 'react'
import type { FeedEntry } from '../core/feed'
import { renderMarkdown } from '../lib/markdown'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { ChannelAvatar } from './ChannelAvatar'
import { FollowButton } from './FollowButton'
import { FeedRow } from './HomeFeed'

export function ChannelView({
  authorHandle,
  channelID,
  onItemClick,
  onChannelClick,
  onHandleClick,
  onEdit,
  onUnpin,
  onUnsubscribe,
  onBack,
  sidebar,
  rightSidebar,
  composerSlot,
}: {
  authorHandle: string
  channelID: string
  onItemClick: (entry: FeedEntry) => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  onHandleClick: (handle: string) => void
  onEdit?: () => void
  onUnpin?: () => void
  onUnsubscribe?: () => void
  onBack: () => void
  sidebar: React.ReactNode
  rightSidebar: React.ReactNode
  composerSlot?: React.ReactNode
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
  const manifest = useFeedStore((s) => s.manifests[channelID])

  // Backfill the manifest cache on cold-mount (e.g. empty channel that
  // contributed no feed entries to the initial refresh). Subsequent updates
  // arrive automatically via JetStream → refreshChannel.
  useEffect(() => {
    if (sub && !manifest) refreshChannel(sub)
  }, [sub, manifest, refreshChannel])

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

  const channelName =
    manifest?.name ??
    sub?.cachedName ??
    channelEntries[0]?.channel.name ??
    channelID
  const coverArt = manifest?.coverArt
  const description = manifest?.description ?? ''

  return (
    <div className="flex-1 p-6">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <div className="flex-1 space-y-5 min-w-0">
          <div className="border border-neutral-200 rounded-lg bg-white p-5 space-y-4">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
            >
              Back
            </button>
            <div className="flex items-center gap-5">
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
                <button
                  type="button"
                  onClick={() => onHandleClick(authorHandle)}
                  className="block max-w-full text-sm text-neutral-500 truncate hover:underline cursor-pointer text-left"
                >
                  @{authorHandle}
                </button>
                {description && (
                  <div
                    className="markdown text-sm text-neutral-700 mt-2 wrap-break-word"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via DOMPurify
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(description),
                    }}
                  />
                )}
                <p className="text-xs text-neutral-500 mt-2">
                  {channelEntries.length} item
                  {channelEntries.length === 1 ? '' : 's'}
                </p>
              </div>
              {(onEdit ||
                onUnpin ||
                onUnsubscribe ||
                (manifest?.visibility === 'public' &&
                  manifest.authorATProtoDID)) && (
                <div className="shrink-0 flex flex-col gap-1.5 items-end">
                  {manifest?.visibility === 'public' &&
                    manifest.authorATProtoDID && (
                      <FollowButton
                        channelAuthorDID={manifest.authorATProtoDID}
                        channelID={channelID}
                        channelName={channelName}
                      />
                    )}
                  {onEdit && (
                    <button
                      type="button"
                      onClick={onEdit}
                      className="px-3 py-1.5 text-xs font-medium text-neutral-700 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors cursor-pointer"
                    >
                      Edit
                    </button>
                  )}
                  {onUnpin && (
                    <button
                      type="button"
                      onClick={onUnpin}
                      className="px-3 py-1.5 text-xs font-medium text-neutral-500 hover:text-red-700 bg-neutral-50 hover:bg-red-50 rounded-md transition-colors cursor-pointer"
                    >
                      Unpin channel
                    </button>
                  )}
                  {onUnsubscribe && (
                    <button
                      type="button"
                      onClick={onUnsubscribe}
                      className="px-3 py-1.5 text-xs font-medium text-neutral-500 hover:text-red-700 bg-neutral-50 hover:bg-red-50 rounded-md transition-colors cursor-pointer"
                    >
                      Unsubscribe
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {composerSlot}

          <div className="border border-neutral-200 rounded-lg bg-white p-4 space-y-4">
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

            {channelEntries.length === 0 ? (
              <p className="text-neutral-500 text-sm">No items yet.</p>
            ) : (
              <ul className="divide-y divide-neutral-200/80">
                {channelEntries.map((entry) => (
                  <FeedRow
                    key={`${entry.channel.channelID}:${entry.item.publishedAt}`}
                    entry={entry}
                    onItemClick={onItemClick}
                    onChannelClick={onChannelClick}
                    onHandleClick={onHandleClick}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
        {rightSidebar}
      </div>
    </div>
  )
}
