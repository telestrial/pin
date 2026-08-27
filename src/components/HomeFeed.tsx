import { Recycle } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { type FeedEntry, feedTimeOf } from '../core/feed'
import type { ItemRef } from '../core/types'
import { useIdentityName } from '../lib/hooks/useIdentityName'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { AttachmentGrid } from './AttachmentMedia'
import { CommentBody, ReplyingTo } from './engagement/CommentBody'
import { EngagementRow } from './engagement/EngagementRow'
import { PostRow } from './PostRow'
import { RichBody } from './RichBody'

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
      // A reposted post arrives when it was circulated, not when it was written —
      // otherwise something reposted today lands wherever it was published, which for
      // an old post is out of sight.
      const cmp = feedTimeOf(a).localeCompare(feedTimeOf(b))
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
  const hasAttachments = !!item.attachments && item.attachments.length > 0

  return (
    <>
      <RichBody
        body={item.summary ?? ''}
        facets={item.facets}
        onHandleClick={onHandleClick}
      />
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

// Who put this post here, when it is not the channel that wrote it.
//
// Above the post rather than inside it, because everything below belongs to the original
// author — the name, the avatar, the body, the counts. This one line is the only part of
// a portal row that is about the person circulating it, and on their own channel page it
// is the only thing distinguishing a repost from something they wrote.
/** What a circulated comment was said under.
 *
 *  A comment lifted out of its thread is the decontextualised-quote problem — every
 *  microblog puts this line on a boosted reply for the same reason. Plain text rather than a
 *  link, because the row itself already opens the post it names and a second affordance to
 *  the same place is one to get wrong.
 */
function RepostedBy({
  repost,
  onHandleClick,
}: {
  repost: NonNullable<FeedEntry['repost']>
  onHandleClick: (handle: string) => void
}) {
  const { channel } = repost
  const identityName = useIdentityName(channel.authorDidDht ?? '')
  const name = channel.authorDidDht ? identityName : channel.authorHandle
  const id = channel.authorDidDht || channel.authorHandle
  if (!id) return null

  return (
    <div className="flex items-center gap-1.5 text-xs text-neutral-500 mb-1">
      <Recycle className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
      <span>Reposted by</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onHandleClick(id)
        }}
        className="truncate hover:underline cursor-pointer"
      >
        @{name}
      </button>
    </div>
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

  // A circulated COMMENT is a comment row, not a post row with something under it: what was
  // circulated is the remark, so the remark is the row and the post it was made on becomes
  // the context line beneath the header. Twitter's shape, and the one that follows from a
  // comment being post-shaped everywhere else.
  if (entry.comment) {
    const post = { channelID: channel.channelID, publishedAt: item.publishedAt }
    return (
      <li>
        <PostRow
          identity={{ kind: 'person', didDht: entry.comment.actor }}
          at={entry.comment.createdAt}
          above={
            entry.repost && (
              <RepostedBy repost={entry.repost} onHandleClick={onHandleClick} />
            )
          }
          onOpen={() => onItemClick(entry)}
          onOpenPerson={onHandleClick}
        >
          <ReplyingTo name={channel.name} />
          <CommentBody
            comment={entry.comment}
            post={post}
            onHandleClick={onHandleClick}
          />
        </PostRow>
      </li>
    )
  }

  return (
    <li>
      <PostRow
        identity={{ kind: 'channel', channel }}
        at={item.publishedAt}
        editedAt={item.editedAt}
        above={
          entry.repost && (
            <RepostedBy repost={entry.repost} onHandleClick={onHandleClick} />
          )
        }
        onOpen={() => onItemClick(entry)}
        onOpenChannel={(c) => onChannelClick(c.authorHandle, c.channelID)}
        onOpenPerson={onHandleClick}
      >
        <PostBody
          item={item}
          channelID={channel.channelID}
          onHandleClick={onHandleClick}
        />
        <EngagementRow
          entry={entry}
          input={{
            item,
            channel: {
              authorHandle: channel.authorHandle,
              channelID: channel.channelID,
              name: channel.name,
            },
          }}
        />
      </PostRow>
    </li>
  )
}
