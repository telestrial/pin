import { useEffect, useMemo } from 'react'
import type { FeedEntry } from '../core/feed'
import type { ItemRef } from '../core/types'
import { useIdentityName } from '../lib/hooks/useIdentityName'
import { renderPostBody } from '../lib/markdown'
import { formatAbsolute, formatRelativeShort } from '../lib/time'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { AttachmentGrid } from './AttachmentMedia'
import { ChannelAvatar } from './channel/ChannelAvatar'
import { PinButton } from './pin/PinButton'

export function HomeFeed({
  onItemClick,
  onChannelClick,
  onHandleClick,
  onErrorClick,
}: {
  onItemClick: (entry: FeedEntry) => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  onHandleClick: (handle: string) => void
  onErrorClick?: () => void
}) {
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const sortOrder = useAuthStore((s) => s.feedSortOrder)
  const setSortOrder = useAuthStore((s) => s.setFeedSortOrder)
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

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      const cmp = a.item.publishedAt.localeCompare(b.item.publishedAt)
      return sortOrder === 'oldest' ? cmp : -cmp
    })
  }, [entries, sortOrder])

  const toolbar = (
    <div className="flex items-center justify-between gap-3">
      <div
        className="flex gap-0.5 bg-neutral-100 rounded-md p-0.5"
        role="tablist"
        aria-label="Sort feed"
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
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
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
        <button
          type="button"
          // Explicit user Refresh → force a network read. Anything less and this
          // button can only ever show what the background pass already cached.
          onClick={() => refresh(subscriptions, true)}
          disabled={loading}
          className="relative px-2.5 py-1 text-xs font-medium text-neutral-700 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors disabled:opacity-50"
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
  )

  if (loading && entries.length === 0 && errors.length === 0) {
    return (
      <div className="border border-neutral-200 rounded-lg bg-white p-4 space-y-4">
        {toolbar}
        <p className="text-neutral-500 text-sm">Loading feed…</p>
      </div>
    )
  }

  // Background re-resolve while content is already showing (stale-while-
  // revalidate): a subtle signal that the feed is fetching current versions
  // off the DHT — which is eventually consistent, so a just-published post may
  // take a moment to appear.
  const refreshing = loading && entries.length > 0

  return (
    <div className="border border-neutral-200 rounded-lg bg-white p-4 space-y-4">
      {toolbar}
      {refreshing && (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span className="size-3 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin" />
          Refreshing…
        </div>
      )}
      {errors.length > 0 && (
        <button
          type="button"
          onClick={onErrorClick}
          disabled={!onErrorClick}
          className="block w-full text-left px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-red-800 text-xs space-y-1 enabled:hover:bg-red-100 enabled:cursor-pointer transition-colors"
        >
          <p className="font-medium flex items-center justify-between gap-2">
            <span>
              {errors.length} channel{errors.length === 1 ? '' : 's'} failed to
              load
            </span>
            {onErrorClick && (
              <span className="text-red-600 font-normal">Manage →</span>
            )}
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
        </button>
      )}

      {sortedEntries.length === 0 ? (
        <p className="text-neutral-500 text-sm">
          No items yet from your subscriptions.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200/80">
          {sortedEntries.map((entry) => (
            <FeedRow
              // Logical row identity, not byte identity: contentHash collides
              // for empty-body posts (all encode to the same 0x20 placeholder)
              // and would even collide same-channel for two attachment-only
              // posts. (channelID, publishedAt) is the pair the rest of the
              // system already uses as logical-post identity — preserved by
              // editItem across edits and by repack across URL swaps.
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
  )
}

function PostBody({
  item,
  channelID,
  onHandleClick,
}: {
  item: ItemRef
  channelID: string
  onHandleClick: (handle: string) => void
}) {
  const html = useMemo(
    () => renderPostBody(item.summary ?? '', item.facets),
    [item.summary, item.facets],
  )
  const hasBody = !!item.summary && item.summary.length > 0
  const hasAttachments = !!item.attachments && item.attachments.length > 0

  // Delegated: a click on an injected mention anchor navigates to that handle's
  // directory and is kept from bubbling to the row's open-post click. The
  // anchors are native <a>, so keyboard activation works through them.
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a[data-mention-handle]')
    if (!a) return
    e.preventDefault()
    e.stopPropagation()
    const handle = a.getAttribute('data-mention-handle') ?? ''
    if (handle) onHandleClick(handle)
  }

  return (
    <>
      {hasBody && (
        // biome-ignore lint/a11y/noStaticElementInteractions: click delegates to nested <a> mentions, which are natively interactive
        // biome-ignore lint/a11y/useKeyWithClickEvents: delegates to nested <a> mentions, which are natively keyboard-accessible
        <div
          className="markdown wrap-break-word text-sm text-neutral-900"
          onClick={handleClick}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via DOMPurify
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {hasAttachments && item.attachments && (
        <AttachmentGrid
          attachments={item.attachments}
          channelID={channelID}
          itemID={item.id}
          publishedAt={item.publishedAt}
        />
      )}
    </>
  )
}

export function FeedRow({
  entry,
  onItemClick,
  onChannelClick,
  onHandleClick,
}: {
  entry: FeedEntry
  onItemClick: (entry: FeedEntry) => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  onHandleClick: (handle: string) => void
}) {
  const { item, channel } = entry
  // did:dht subs display + navigate by identity-doc; legacy handle subs show the
  // raw handle (no atproto profile lookup).
  const identityName = useIdentityName(channel.authorDidDht ?? '')
  const authorName = channel.authorDidDht ? identityName : channel.authorHandle
  const authorId = channel.authorDidDht || channel.authorHandle

  const handleChannelClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    onChannelClick(channel.authorHandle, channel.channelID)
  }

  const handleAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onHandleClick(authorId)
  }

  return (
    <li>
      {/* biome-ignore lint/a11y/useSemanticElements: row contains nested interactives (channel buttons, pin button, audio/video controls) so a button element would nest interactives */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onItemClick(entry)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onItemClick(entry)
          }
        }}
        className="py-4 px-2 -mx-2 rounded hover:bg-neutral-50 cursor-pointer transition-colors"
      >
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleChannelClick}
            className="self-start shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-green-600 cursor-pointer"
            aria-label={`View channel ${channel.name}`}
          >
            <ChannelAvatar
              channelID={channel.channelID}
              channelName={channel.name}
              authorHandle={channel.authorHandle}
              avatar={channel.avatar}
            />
          </button>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <button
                  type="button"
                  onClick={handleChannelClick}
                  className="block max-w-full text-sm font-semibold text-neutral-900 truncate hover:underline cursor-pointer text-left"
                >
                  {channel.name}
                </button>
                {/* did:dht subs display the identity-doc username; legacy subs the
                    atproto handle. Hidden only if neither identifier exists. */}
                {authorId && (
                  <button
                    type="button"
                    onClick={handleAuthorClick}
                    className="block max-w-full text-xs text-neutral-500 truncate hover:underline cursor-pointer text-left"
                  >
                    @{authorName}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <p
                  className="text-xs text-neutral-500 whitespace-nowrap"
                  title={formatAbsolute(item.publishedAt)}
                >
                  {formatRelativeShort(item.publishedAt)}
                  {item.editedAt && (
                    <span title={`Edited ${formatAbsolute(item.editedAt)}`}>
                      {' · edited '}
                      {formatRelativeShort(item.editedAt)}
                    </span>
                  )}
                </p>
                <PinButton
                  input={{
                    item,
                    channel: {
                      authorHandle: channel.authorHandle,
                      channelID: channel.channelID,
                      name: channel.name,
                    },
                  }}
                />
              </div>
            </div>
            <PostBody
              item={item}
              channelID={channel.channelID}
              onHandleClick={onHandleClick}
            />
          </div>
        </div>
      </div>
    </li>
  )
}
