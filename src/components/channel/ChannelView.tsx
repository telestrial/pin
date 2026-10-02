import { useEffect, useMemo, useState } from 'react'
import { content_key_collection } from '../../../crates/pin-core/pkg/pin_core.js'
import { buildSubscribeURL } from '../../core/channels'
import {
  contributingChannelOf,
  entriesForChannel,
  type FeedEntry,
  feedTimeOf,
  portalKey,
} from '../../core/feed'
import type { ChannelImage, ChannelManifest } from '../../core/types'
import {
  isKeyNotHeld,
  resolveChannelViaLocator,
} from '../../lib/channelLocator'
import { subscribeDocChanges } from '../../lib/docs'
import { useChannelClaim } from '../../lib/hooks/useChannelClaim'
import {
  useChannelFollowerCount,
  useChannelFollowers,
} from '../../lib/hooks/useFollowers'
import { useIdentityName } from '../../lib/hooks/useIdentityName'
import { useItemBlobURL } from '../../lib/hooks/useItemBytes'
import { renderMarkdown } from '../../lib/markdown'
import { readMemberships } from '../../lib/members'
import { useAuthStore } from '../../stores/auth'
import { renderable, useFeedStore } from '../../stores/feed'
import { useReadChannels } from '../../stores/reading'
import { useToastStore } from '../../stores/toast'
import { FollowButton } from '../FollowButton'
import { FeedRow } from '../HomeFeed'
import { PersonRow } from '../PersonRow'
import { ChannelPinButton } from '../pin/ChannelPinButton'
import { PinIcon } from '../pin/PinIcon'
import { Stat } from '../ui/Stat'
import { WatchButton } from '../WatchButton'
import { ChannelAvatar } from './ChannelAvatar'
import { ChannelOwnerMenu } from './ChannelOwnerMenu'
import { DeadRepost } from './DeadRepost'
import { MembersPanel } from './MembersPanel'

/** Why a browsed channel cannot be read, when the reason is a key rather than the network.
 *
 *  `not-invited` is a Secret channel this identity holds no membership in; `opening` is
 *  one it was invited to whose key the Curator has not climbed to yet. */
type Locked = 'not-invited' | 'opening'

/** A channel this device holds nothing for, read with the key the navigation carried.
 *
 *  The bottom rung of the resolution ladder, reached when the ones above have nothing: a
 *  channel you watch or own is in the feed store because the pull loop put it there, and a
 *  channel you are merely LOOKING at is in no store at all. Before this, arriving at one
 *  meant arriving at an empty page, which is why the page only ever offered to un-watch —
 *  there was no way to be on it without already holding it.
 *
 *  Nothing is written back. Browsing is a read, and what to do about the channel is a
 *  decision the buttons on the page carry. */
function useBrowsedChannel(
  channelID: string,
  channelKey: string | undefined,
  author: string,
  enabled: boolean,
) {
  const [manifest, setManifest] = useState<ChannelManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [locked, setLocked] = useState<Locked | null>(null)
  // Bumped when a key for this channel is climbed to, which is what reads it again.
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is a re-read trigger — bumping it resolves again
  useEffect(() => {
    let cancelled = false
    setManifest(null)
    setLocked(null)
    if (!enabled || !channelKey) return
    setLoading(true)
    resolveChannelViaLocator(channelKey, author)
      .then((m) => {
        if (!cancelled) setManifest(m)
      })
      .catch(async (err) => {
        // A locator that will not resolve is a read failure, never an empty channel. The
        // page says it could not be read rather than that it holds nothing — unless the
        // object said it is members-only and no key is held for it, which is an answer.
        if (!isKeyNotHeld(err)) return
        const memberships = await readMemberships().catch(() => null)
        if (cancelled || !memberships) return
        setLocked(
          memberships.some((m) => m.channelID === channelID)
            ? 'opening'
            : 'not-invited',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channelID, channelKey, author, enabled, attempt])

  // Invited and waiting on the climb: the Curator writes the key on its next pull, and
  // that write is the moment there is something new to read.
  useEffect(() => {
    if (locked !== 'opening') return
    const collection = content_key_collection()
    const prefix = `${channelID}:`
    return subscribeDocChanges(({ collection: c, rkey }) => {
      if (c === collection && rkey.startsWith(prefix)) setAttempt((n) => n + 1)
    })
  }, [locked, channelID])

  return { manifest, loading, locked }
}

export function ChannelView({
  authorHandle,
  channelID,
  channelKey,
  authorDid,
  onItemClick,
  onChannelClick,
  onHandleClick,
  onEdit,
  onUnpin,
  onBack,
  sidebar,
  rightSidebar,
  composerSlot,
}: {
  authorHandle: string
  channelID: string
  /** Present only when browsing — see `useBrowsedChannel`. */
  channelKey?: string
  /** Whose channel it is, when browsing: the did:dht its manifest must be signed by. */
  authorDid?: string
  onItemClick: (entry: FeedEntry) => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  onHandleClick: (handle: string) => void
  onEdit?: () => void
  onUnpin?: () => void
  onBack: () => void
  sidebar: React.ReactNode
  rightSidebar: React.ReactNode
  composerSlot?: React.ReactNode
}) {
  // channelID (derived from K) uniquely identifies a subscription — match on it
  // alone (authorHandle is empty for did:dht subs, so it's not a usable key).
  // Watched, or shown by somebody followed — either way this identity reads it, and the
  // pull loop keeps it cached.
  const sub = useReadChannels().find((x) => x.channelID === channelID)
  const sortOrder = useAuthStore((s) => s.feedSortOrder)
  const setSortOrder = useAuthStore((s) => s.setFeedSortOrder)
  // The owned channel itself, not just whether it is owned: removing a dead portal is a
  // write, and a write needs the channel's key. myChannels is the authority on that —
  // the owner's own subscription carries the same key, but only because owners
  // auto-subscribe, which is a fact about a different store.
  const owned = useAuthStore((s) =>
    s.myChannels.find((c) => c.channelID === channelID),
  )
  const isOwned = owned !== undefined
  // The link that lets somebody open this channel. On the page of a channel you own
  // because that is where you go to share it — and for an unlisted channel it is the
  // only way anybody gets in, since no directory names it.
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const addToast = useToastStore((s) => s.addToast)
  const shareLink =
    owned && myDidDht ? buildSubscribeURL(myDidDht, owned.channelKey) : null
  const entries = useFeedStore((s) => s.entries)
  const portals = useFeedStore((s) => s.portals)
  const feedLoading = useFeedStore((s) => s.loading)
  const refreshChannel = useFeedStore((s) => s.refreshChannel)
  const held = useFeedStore((s) => s.manifests[channelID])

  // Held or browsed: one page, two rungs. `held` is what the pull loop keeps current for
  // a channel you watch or own; the resolve below is for one you are only looking at.
  const browsing = !sub && !isOwned
  const browsed = useBrowsedChannel(
    channelID,
    channelKey,
    authorDid ?? '',
    browsing && !held,
  )
  // Whether this channel is one of your public follows. Watching is hidden behind it
  // because following already watches.
  const following = useAuthStore((s) =>
    s.follows.some((f) => f.channelID === channelID),
  )
  // K, from whichever side has it: the subscription when you watch it, the navigation
  // when you are only looking. Without one there is nothing to start a watch from.
  const watchKey = sub?.channelKey ?? channelKey
  const manifest = held ?? browsed.manifest
  const loading = feedLoading || browsed.loading
  // did:dht author → identity-doc name; legacy handle author → the raw handle.
  const identityName = useIdentityName(manifest?.authorDidDht ?? '')
  const authorName = manifest?.authorDidDht ? identityName : authorHandle

  // A public channel you authored. Ownership is local — a channel you created
  // is in myChannels (identity-independent), so this no longer needs the
  // manifest's atproto DID. Claim (advertise in the identity-doc) applies only
  // to public channels you own — obscure channels aren't advertised, others'
  // channels you Follow not claim.
  // Public means followable, and that is the whole of what gates the Followers count
  // beside the Follow button: a `FollowEdge` carries no K and resolves through the
  // author's directory, where an unlisted channel is absent by construction. So nobody
  // can follow one, the scan is structurally empty forever, and a "0" there would state a
  // fact about the channel where the truth is that the relation does not apply. Spelled
  // once, so the control and the number it explains cannot disagree about which is which.
  const isPublic = manifest?.visibility === 'public'
  const isOwnPublic = isOwned && isPublic
  const { claimed, setClaimed } = useChannelClaim(channelID, isOwnPublic)
  // The list is who this device knows of; the number is the author's published tally
  // where one is held, which reaches past that — strangers who followed by knock — and
  // never reads below the list.
  const followers = useChannelFollowers(isPublic ? channelID : '')
  const followerCount = useChannelFollowerCount(
    isPublic ? channelID : '',
    watchKey,
    authorDid ?? '',
    browsing,
    followers?.length ?? null,
  )
  // The list behind the number, opened from it. Folded away by default because this
  // page's body is the channel's feed, and a standing list of people would push the posts
  // down on every visit.
  const [showFollowers, setShowFollowers] = useState(false)
  // Who can read a Secret channel you own, and where you invite and remove them. Folded
  // away like the Followers list, for the same reason.
  const isOwnSecret = isOwned && manifest?.visibility === 'secret'
  const [showMembers, setShowMembers] = useState(false)

  // Backfill the manifest cache on cold-mount (e.g. empty channel that
  // contributed no feed entries to the initial refresh). Updates arrive on
  // manual Refresh (read-on-refresh — no firehose in the did:dht world).
  useEffect(() => {
    if (sub && !manifest) refreshChannel(sub)
  }, [sub, manifest, refreshChannel])

  const channelEntries = useMemo(() => {
    // A browsed channel contributes nothing to the feed store, so its rows come from the
    // manifest this page resolved — through the same collation a watched channel's rows
    // go through, so the two cannot drift into two ideas of what a channel published.
    if (browsing && manifest) {
      const sorted = entriesForChannel(
        {
          authorHandle,
          authorDidDht: manifest.authorDidDht,
          channelID,
          name: manifest.name,
          avatar: manifest.avatar,
        },
        manifest,
        // Through the store's own converter rather than a second reading of what a
        // resolved portal is. A browsed channel's portals are unresolved in practice —
        // the resolution pass walks watched channels — so this is usually empty, and it
        // is the same empty an unresolved portal produces anywhere else.
        renderable(portals),
      )
      sorted.sort((a, b) => {
        const cmp = feedTimeOf(a).localeCompare(feedTimeOf(b))
        return sortOrder === 'oldest' ? cmp : -cmp
      })
      return sorted
    }
    // What this channel PUBLISHED, which includes the posts it circulates. A portal
    // carries the original author's identity on `channel`, so matching on that would
    // leave a channel's own reposts off its own page.
    const filtered = entries.filter((e) => {
      const from = contributingChannelOf(e)
      return from.authorHandle === authorHandle && from.channelID === channelID
    })
    filtered.sort((a, b) => {
      const cmp = feedTimeOf(a).localeCompare(feedTimeOf(b))
      return sortOrder === 'oldest' ? cmp : -cmp
    })
    return filtered
  }, [entries, authorHandle, channelID, sortOrder, browsing, manifest, portals])

  // Portals in THIS channel with nothing at the other end, for its owner only. They
  // produce no feed entry — a resolution that failed contributes nothing — so they are
  // gathered from the manifest and placed by the same clock the entries use.
  const deadReposts = useMemo(() => {
    if (!isOwned) return []
    return (manifest?.reposts ?? [])
      .map((repost) => ({ repost, state: portals[portalKey(repost)]?.state }))
      .filter(
        (
          d,
        ): d is {
          repost: (typeof d)['repost']
          state: 'deleted' | 'unavailable' | 'unpublished'
        } =>
          d.state === 'deleted' ||
          d.state === 'unavailable' ||
          d.state === 'unpublished',
      )
      .sort((a, b) => {
        const cmp = a.repost.repostedAt.localeCompare(b.repost.repostedAt)
        return sortOrder === 'oldest' ? cmp : -cmp
      })
  }, [isOwned, manifest, portals, sortOrder])

  const channelName =
    manifest?.name ??
    sub?.cachedName ??
    channelEntries[0]?.channel.name ??
    channelID
  const avatar = manifest?.avatar
  const coverImage = manifest?.cover
  const description = manifest?.description ?? ''

  // A Secret channel this identity cannot read says that and nothing else: no name, no
  // picture, no button to ask. A request button would turn Secret into Private-but-unlisted
  // and hand part of who-knows-it-exists to whoever forwarded the link.
  if (browsing && !manifest && browsed.locked) {
    return (
      <div className="flex-1 p-6 lg:min-h-0">
        <div className="flex flex-col gap-6 lg:h-full lg:min-h-0 lg:flex-row lg:items-start">
          {sidebar}
          <div className="flex-1 min-w-0">
            <div className="border border-neutral-200 rounded-lg bg-white p-5 space-y-3">
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-600 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
              >
                Back
              </button>
              {browsed.locked === 'not-invited' ? (
                <p className="text-sm text-neutral-700">You’re not invited.</p>
              ) : (
                <p className="text-sm text-neutral-700">
                  Your invitation to this channel hasn’t opened yet. It will
                  appear here once it does.
                </p>
              )}
            </div>
          </div>
          {rightSidebar}
        </div>
      </div>
    )
  }

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
                  <div className="min-w-0 flex items-center gap-5">
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
                      {/* Author line: navigate to the author's directory. did:dht
                          (the identity now) → identity-doc name; legacy handle →
                          raw handle. Hidden only when neither exists. */}
                      {(manifest?.authorDidDht || authorHandle) &&
                        authorName && (
                          <button
                            type="button"
                            onClick={() =>
                              onHandleClick(
                                manifest?.authorDidDht ?? authorHandle,
                              )
                            }
                            className="block max-w-full text-sm text-neutral-500 truncate hover:underline cursor-pointer text-left"
                          >
                            @{authorName}
                          </button>
                        )}
                    </div>
                    {isPublic && (
                      <Stat
                        value={followerCount}
                        label="Followers"
                        onClick={
                          followers && followers.length > 0
                            ? () => setShowFollowers((v) => !v)
                            : undefined
                        }
                        expanded={showFollowers}
                      />
                    )}
                  </div>
                  {/* Actions: below the cover, upper-right, even with the
                      name/Unclaimed row. */}
                  {(onEdit || onUnpin || manifest) && (
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
                          {shareLink && (
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(shareLink)
                                addToast('Link copied')
                              }}
                              className="px-3 py-1.5 text-xs font-medium text-neutral-700 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors cursor-pointer"
                            >
                              Copy link
                            </button>
                          )}
                          {isOwnSecret && (
                            <button
                              type="button"
                              onClick={() => setShowMembers((v) => !v)}
                              aria-expanded={showMembers}
                              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                                showMembers
                                  ? 'text-neutral-900 bg-neutral-200'
                                  : 'text-neutral-700 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200'
                              }`}
                            >
                              Members
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
                          {/* Your own voice, as a claim you can take back. The create
                              follows a public channel you author — which is what puts
                              you among its followers — and this is the ONLY place that
                              can be undone: the sidebar keeps owned channels out of
                              Following, and `followsOfOthers` keeps a self-follow out of
                              the profile's. So the page the claim is about is the page
                              that changes it. */}
                          {isOwnPublic && manifest?.authorDidDht && (
                            <FollowButton
                              authorDidDht={manifest.authorDidDht}
                              channelID={channelID}
                              channelName={channelName}
                              owned
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
                        // Somebody else's channel: the relation you have with it,
                        // as one control in three states — none, Watching, Following.
                        //
                        // Following supersedes Watching rather than sitting beside it,
                        // because a follow already watches: the two shown together would
                        // name a state that does not exist. And Follow renders only for a
                        // public channel, because a FollowEdge carries no K and resolves
                        // through the author's directory, where an unlisted channel is
                        // absent by construction. Absent rather than disabled — there is
                        // nothing to enable.
                        <>
                          {!following && manifest && watchKey && (
                            <WatchButton
                              authorHandle={authorHandle}
                              didDht={manifest.authorDidDht}
                              channelID={channelID}
                              channelKey={watchKey}
                              channelName={channelName}
                              manifest={manifest}
                            />
                          )}
                          {isPublic && manifest.authorDidDht && (
                            <FollowButton
                              authorDidDht={manifest.authorDidDht}
                              channelID={channelID}
                              channelName={channelName}
                            />
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

          {isOwnSecret && showMembers && owned && (
            <MembersPanel
              channelID={channelID}
              channelKey={owned.channelKey}
              onHandleClick={onHandleClick}
            />
          )}

          {showFollowers && followers && followers.length > 0 && (
            <section aria-label="Followers" className="space-y-2">
              <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wide px-1">
                Followers
              </h2>
              {/* The people who follow this channel, among the identities this device has
                  read. The number above can be larger — it is the author's own tally,
                  which counts followers nobody here has read — and the list says so
                  rather than looking like the whole of it. */}
              {followerCount !== null && followerCount > followers.length && (
                <p className="text-xs text-neutral-500 px-1">
                  The {followers.length} you know of
                </p>
              )}
              <div className="bg-white border border-neutral-200 rounded-lg divide-y divide-neutral-100">
                {followers.map((did) => (
                  <PersonRow
                    key={did}
                    didDht={did}
                    onHandleClick={onHandleClick}
                  />
                ))}
              </div>
            </section>
          )}

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
                <button
                  type="button"
                  // Explicit user Refresh → force a network read (see HomeFeed).
                  onClick={() => sub && refreshChannel(sub, true)}
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

            {channelEntries.length === 0 && deadReposts.length === 0 ? (
              <p className="text-neutral-500 text-sm">No items yet.</p>
            ) : (
              <ul className="divide-y divide-neutral-200/80">
                {deadReposts.map((dead) => (
                  <DeadRepost
                    key={`dead:${portalKey(dead.repost)}`}
                    channel={{ channelID, channelKey: owned?.channelKey ?? '' }}
                    repost={dead.repost}
                    state={dead.state}
                  />
                ))}
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
