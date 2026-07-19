import { useEffect, useMemo } from 'react'
import type { FeedEntry } from '../../core/feed'
import type { ChannelImage } from '../../core/types'
import { useChannelClaim } from '../../lib/hooks/useChannelClaim'
import { useIdentityName } from '../../lib/hooks/useIdentityName'
import { useItemBlobURL } from '../../lib/hooks/useItemBytes'
import { renderMarkdown } from '../../lib/markdown'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { FollowButton } from '../FollowButton'
import { FeedRow } from '../HomeFeed'
import { ChannelPinButton } from '../pin/ChannelPinButton'
import { PinIcon } from '../pin/PinIcon'
import { ChannelAvatar } from './ChannelAvatar'
import { ChannelOwnerMenu } from './ChannelOwnerMenu'

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
  const myDID = useAuthStore((s) => s.atprotoDID)
  const entries = useFeedStore((s) => s.entries)
  const loading = useFeedStore((s) => s.loading)
  const live = useFeedStore((s) => s.live)
  const refreshChannel = useFeedStore((s) => s.refreshChannel)
  const manifest = useFeedStore((s) => s.manifests[channelID])
  // did:dht author → identity-doc name; legacy handle author → the raw handle.
  const identityName = useIdentityName(manifest?.authorDidDht ?? '')
  const authorName = manifest?.authorDidDht ? identityName : authorHandle

  // A public channel you authored. Claim (self-follow) only applies here —
  // obscure channels can't be followed, others' channels you Follow not claim.
  const isOwnPublic = !!(
    manifest?.visibility === 'public' &&
    manifest.authorATProtoDID &&
    manifest.authorATProtoDID === myDID
  )
  const { claimed, setClaimed } = useChannelClaim(channelID, isOwnPublic)

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
  const avatar = manifest?.avatar
  const coverImage = manifest?.cover
  const description = manifest?.description ?? ''

  return (
    <div className="flex-1 p-6 lg:min-h-0">
      <div className="flex flex-col gap-6 lg:h-full lg:min-h-0 lg:flex-row lg:items-start">
        {sidebar}
        <div className="flex-1 space-y-5 min-w-0 lg:max-h-full lg:overflow-y-auto">
          <div className="border border-neutral-200 rounded-lg bg-white overflow-hidden">
            {/* Cover banner full-bleed at the card top; Back overlaid
                top-left. Mirrors the My Profile (HandleDirectory) header. */}
            <div className="relative">
              {coverImage ? (
                <ChannelCoverBanner cover={coverImage} />
              ) : (
                <div className="h-32 bg-linear-to-br from-neutral-100 to-neutral-200" />
              )}
              <button
                type="button"
                onClick={onBack}
                className="absolute top-3 left-3 inline-flex items-center px-2.5 py-1 text-xs font-medium text-white bg-black/40 hover:bg-black/60 backdrop-blur-sm rounded-full transition-colors cursor-pointer"
              >
                Back
              </button>
            </div>
            <div className="px-5 pb-5">
              <div className="flex items-start gap-4">
                {/* Avatar overlaps the banner's bottom edge. */}
                <div className="relative z-10 -mt-10 rounded-full ring-4 ring-white shrink-0">
                  <ChannelAvatar
                    channelID={channelID}
                    channelName={channelName}
                    authorHandle={authorHandle}
                    avatar={avatar}
                    size="lg"
                  />
                </div>
                <div className="flex-1 min-w-0 flex items-start justify-between gap-3 pt-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <h1 className="text-xl font-semibold text-neutral-900 truncate">
                        {channelName}
                      </h1>
                      {isOwnPublic && claimed === false && (
                        <span className="shrink-0 inline-flex items-center px-2 py-0.5 text-[11px] font-medium text-neutral-400 bg-neutral-100 border border-neutral-200 rounded-full">
                          Unclaimed
                        </span>
                      )}
                    </div>
                    {/* did:dht channels carry no atproto handle; hide the line
                        rather than render a bare "@" (identity-doc display = 5b). */}
                    {authorHandle && (
                      <button
                        type="button"
                        onClick={() => onHandleClick(authorHandle)}
                        className="block max-w-full text-sm text-neutral-500 truncate hover:underline cursor-pointer text-left"
                      >
                        @{authorName}
                      </button>
                    )}
                  </div>
                  {/* Actions: below the cover, upper-right, even with the
                      name/Unclaimed row. */}
                  {(onEdit || onUnpin || onUnsubscribe || manifest) && (
                    <div className="shrink-0 flex items-center gap-1.5">
                      {onEdit || onUnpin ? (
                        // Owned channel: Edit channel · ⋯ context menu · pin.
                        <>
                          {onEdit && (
                            <button
                              type="button"
                              onClick={onEdit}
                              className="px-3 py-1.5 text-xs font-medium text-neutral-700 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors cursor-pointer"
                            >
                              Edit channel
                            </button>
                          )}
                          {/* Context menu — only the claim toggle, so it
                              shows for public channels only (claim doesn't
                              apply to obscure ones). */}
                          {isOwnPublic && claimed !== null && (
                            <ChannelOwnerMenu
                              channelName={channelName}
                              claimed={claimed}
                              onClaimedChange={setClaimed}
                            />
                          )}
                          {/* Channel pin icon — separate third element. You
                              authored this channel, so its bytes are pinned in
                              your storage → the icon renders activated (filled
                              green). Clicking it unpins the channel (the
                              retract, gated by onUnpin's typed-DELETE confirm). */}
                          {onUnpin && (
                            <button
                              type="button"
                              onClick={onUnpin}
                              title="Unpin this channel"
                              // Owned: same axis as the post PinButton — owned
                              // green dimmed at rest, waking brighter on hover.
                              className="p-1 cursor-pointer transition-all duration-300 text-green-700 opacity-50 hover:opacity-100 hover:text-green-600"
                            >
                              <PinIcon state="pinned" aria-hidden="true" />
                            </button>
                          )}
                        </>
                      ) : (
                        // Non-owned channel: Follow (public only) + Unsubscribe.
                        <>
                          {manifest?.visibility === 'public' &&
                            manifest.authorDidDht && (
                              <FollowButton
                                authorDidDht={manifest.authorDidDht}
                                channelID={channelID}
                                channelName={channelName}
                              />
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
                          {/* Whole-channel pin (snapshot/catch-up/unpin) —
                              visibility-agnostic, so it shows for obscure
                              channels too. Rightmost, mirroring the owned row. */}
                          <ChannelPinButton
                            manifest={manifest}
                            authorHandle={authorHandle}
                            channelID={channelID}
                            channelName={channelName}
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {description && (
                <div
                  className="markdown text-sm text-neutral-700 mt-3 wrap-break-word"
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

// Full-bleed cover banner for the channel header. Mirrors HandleDirectory's
// CoverBanner — fetches the banner bytes via the item cache, falls back to a
// neutral fill on error/while-loading.
function ChannelCoverBanner({ cover }: { cover: ChannelImage }) {
  const { url, error } = useItemBlobURL(
    cover.itemURL,
    cover.mimeType,
    cover.contentHash,
  )
  if (error || !url) {
    return <div className="h-32 bg-neutral-100" />
  }
  return (
    <img src={url} alt="" className="w-full h-32 object-cover bg-neutral-100" />
  )
}
