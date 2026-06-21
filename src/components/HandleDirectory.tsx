import { AtpAgent } from '@atproto/api'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchChannel } from '../core/channels'
import { listFollows, parseChannelAtURI } from '../core/follow'
import { getProfileRecord, type ProfileRecord } from '../core/profile'
import type { ChannelManifest } from '../core/types'
import { formatBytes } from '../lib/format'
import { useItemBlobURL } from '../lib/hooks/useItemBytes'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { ChannelAvatar } from './channel/ChannelAvatar'
import { ChannelHeroCard } from './channel/ChannelHeroCard'
import { FollowHandleButton } from './FollowHandleButton'

type ChannelEntry = {
  authorDID: string
  authorHandle: string
  channelID: string
  manifest: ChannelManifest
}

type State =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | {
      kind: 'loaded'
      did: string
      profile: ProfileRecord | null
      ownChannels: ChannelEntry[]
      followedChannels: ChannelEntry[]
    }
  | { kind: 'error'; message: string }

export function HandleDirectory({
  handle: rawHandle,
  onBack,
  onChannelClick,
  onHandleClick,
  onEditProfile,
  onCreate,
  sidebar,
  rightSidebar,
}: {
  handle: string
  // Optional: present when the directory was reached contextually (a
  // @handle click somewhere with a calling view to return to). Absent
  // when reached as primary nav from the sidebar's My Profile — no
  // Back affordance renders in that case.
  onBack?: () => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  onHandleClick: (handle: string) => void
  // Only wired when the directory belongs to the signed-in user. Home
  // skips passing this when isSelf would be false, so an undefined here
  // is the signal to ProfileHeader to hide the Edit affordance.
  onEditProfile?: () => void
  // Create a new channel. Gated to self by the render below; the handler
  // itself carries the Bluesky-session gate (same as onEditProfile).
  onCreate?: () => void
  sidebar: React.ReactNode
  rightSidebar: React.ReactNode
}) {
  const myHandle = useAuthStore((s) => s.atprotoHandle)
  const [state, setState] = useState<State>({ kind: 'loading' })

  // Defensive normalize: callers should pass a bare handle, but a stray
  // leading `@` (from a paste, say) shouldn't break the lookup.
  const handle = rawHandle.replace(/^@+/, '')

  useEffect(() => {
    let cancelled = false
    if (!handle) {
      setState({ kind: 'not-found' })
      return
    }
    setState({ kind: 'loading' })

    async function load() {
      const unauthed = new AtpAgent({ service: 'https://bsky.social' })

      // Resolve handle → DID. describeRepo is the unauthenticated path
      // (the same one doBoot uses); it returns { handle, did, didDoc }
      // for any repo on the network.
      let did: string
      try {
        const r = await unauthed.com.atproto.repo.describeRepo({ repo: handle })
        did = r.data.did
      } catch {
        if (!cancelled) setState({ kind: 'not-found' })
        return
      }

      // Profile + follows in parallel. Both are best-effort — a missing
      // profile or a refused listRecords just means an emptier page.
      const [profile, follows] = await Promise.all([
        getProfileRecord(handle).catch(() => null),
        listFollows(handle).catch(() => []),
      ])

      // Resolve each follow's subject → channel manifest + author handle.
      // Both lookups parallel within a follow (no dependency between them)
      // and across follows (the outer Promise.all). For follows pointing
      // at channels the user is also subscribed to, feedStore.manifests
      // already has the decrypted manifest (JetStream keeps it fresh) —
      // skip the fetchChannel round-trip in that case. Obscure channels
      // in the follow list (which the Follow UI gates against, so mostly
      // belt-and-suspenders) fail fetchChannel; we drop them silently.
      const parsedFollows = follows.flatMap((f) => {
        const parsed = parseChannelAtURI(f.record.subject)
        return parsed ? [parsed] : []
      })
      const cachedManifests = useFeedStore.getState().manifests
      const channelResults = await Promise.all(
        parsedFollows.map(async (parsed) => {
          try {
            const cached = cachedManifests[parsed.channelID]
            // Only trust the cache when the cached manifest's authoring
            // DID matches the follow's subject; the channelID alone isn't
            // globally namespaced (it's derived from K).
            const cacheHit =
              cached && cached.authorATProtoDID === parsed.authorDID
            const [manifest, handleResp] = await Promise.all([
              cacheHit
                ? Promise.resolve(cached)
                : fetchChannel(parsed.authorDID, parsed.channelID),
              unauthed.com.atproto.repo
                .describeRepo({ repo: parsed.authorDID })
                .catch(() => null),
            ])
            return {
              authorDID: parsed.authorDID,
              authorHandle: handleResp?.data.handle ?? '',
              channelID: parsed.channelID,
              manifest,
            } as ChannelEntry
          } catch {
            return null
          }
        }),
      )
      const channels = channelResults.filter(
        (c): c is ChannelEntry => c !== null,
      )

      const ownChannels = channels.filter((c) => c.authorDID === did)
      const followedChannels = channels.filter((c) => c.authorDID !== did)

      if (!cancelled) {
        setState({
          kind: 'loaded',
          did,
          profile,
          ownChannels,
          followedChannels,
        })
      }
    }

    load().catch((err) => {
      if (!cancelled) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [handle])

  const isSelf = myHandle === handle

  // Inline back pill, used by loading / not-found / error states (no
  // cover banner there to overlay on). The loaded state renders its
  // own Back overlay on top of the cover banner.
  const inlineBackButton = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="self-start inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
    >
      Back
    </button>
  ) : null

  return (
    <div className="flex-1 p-6">
      <div className="flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <div className="flex-1 min-w-0 space-y-5">
          {state.kind === 'loading' && (
            <div className="bg-white border border-neutral-200 rounded-lg p-5 flex flex-col gap-4">
              {inlineBackButton}
              <p className="text-center text-sm text-neutral-500">
                Loading @{handle}…
              </p>
            </div>
          )}

          {state.kind === 'not-found' && (
            <div className="bg-white border border-neutral-200 rounded-lg p-5 flex flex-col gap-4">
              {inlineBackButton}
              <div className="text-center space-y-2">
                <h1 className="text-lg font-semibold text-neutral-900">
                  @{handle}
                </h1>
                <p className="text-sm text-neutral-500">
                  That handle doesn't resolve to an atproto identity.
                </p>
              </div>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="bg-white border border-neutral-200 rounded-lg p-5 flex flex-col gap-4">
              {inlineBackButton}
              <div className="text-center space-y-2">
                <h1 className="text-lg font-semibold text-neutral-900">
                  @{handle}
                </h1>
                <p className="text-sm text-red-600">
                  Failed to load: {state.message}
                </p>
              </div>
            </div>
          )}

          {state.kind === 'loaded' && (
            <LoadedDirectory
              handle={handle}
              did={state.did}
              isSelf={isSelf}
              profile={state.profile}
              ownChannels={state.ownChannels}
              followedChannels={state.followedChannels}
              onBack={onBack}
              onChannelClick={onChannelClick}
              onHandleClick={onHandleClick}
              onEditProfile={isSelf ? onEditProfile : undefined}
              onCreate={isSelf ? onCreate : undefined}
            />
          )}
        </div>
        {rightSidebar}
      </div>
    </div>
  )
}

function LoadedDirectory({
  handle,
  did,
  isSelf,
  profile,
  ownChannels,
  followedChannels,
  onBack,
  onChannelClick,
  onHandleClick,
  onEditProfile,
  onCreate,
}: {
  handle: string
  did: string
  isSelf: boolean
  profile: ProfileRecord | null
  ownChannels: ChannelEntry[]
  followedChannels: ChannelEntry[]
  onBack?: () => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  onHandleClick: (handle: string) => void
  onEditProfile?: () => void
  onCreate?: () => void
}) {
  const isEmpty =
    !profile && ownChannels.length === 0 && followedChannels.length === 0

  return (
    <div className="space-y-5">
      <ProfileHeader
        handle={handle}
        did={did}
        isSelf={isSelf}
        profile={profile}
        followingCount={followedChannels.length}
        onBack={onBack}
        onEdit={onEditProfile}
      />

      {isEmpty && (
        <div className="bg-white border border-neutral-200 rounded-lg p-8 text-center text-sm text-neutral-500">
          No Pin profile yet.
        </div>
      )}

      {/* Big create affordance, self-only, above the listed channels. No
          noun on it — the naming question is parked. */}
      {onCreate && (
        <button
          type="button"
          onClick={onCreate}
          className="w-full flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-neutral-200 bg-white py-8 text-base font-medium text-neutral-500 hover:border-green-400 hover:text-green-700 hover:bg-green-50/40 transition-colors cursor-pointer"
        >
          <Plus className="size-6" />
          Create
        </button>
      )}

      {/* Public channels this person owns — one full-bodied hero card each,
          cover art (or identity gradient) forward, unlabeled (naming parked).
          On your own profile the badge also carries storage bytes (you own
          these); on someone else's it's item count only. */}
      {ownChannels.length > 0 && (
        <div className="space-y-3">
          {ownChannels.map((c) => {
            const count = c.manifest.items.length
            const items = `${count} ${count === 1 ? 'item' : 'items'}`
            const badge = isSelf
              ? `${items} · ${formatBytes(channelContentBytes(c.manifest))}`
              : items
            return (
              <ChannelHeroCard
                key={`${c.authorDID}:${c.channelID}`}
                channelID={c.channelID}
                channelName={c.manifest.name}
                authorHandle={c.authorHandle}
                avatar={c.manifest.avatar}
                cover={c.manifest.cover}
                description={c.manifest.description}
                badge={badge}
                onClick={() => onChannelClick(c.authorHandle, c.channelID)}
              />
            )
          })}
        </div>
      )}

      {followedChannels.length > 0 && (
        <Section title="Following">
          {followedChannels.map((c) => (
            <ChannelRow
              key={`${c.authorDID}:${c.channelID}`}
              entry={c}
              showAuthor
              onChannelClick={onChannelClick}
              onHandleClick={onHandleClick}
            />
          ))}
        </Section>
      )}
    </div>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="shrink-0 leading-tight">
      <div className="text-2xl font-bold text-neutral-900">{value}</div>
      <div className="text-xs text-neutral-500 uppercase tracking-wide">
        {label}
      </div>
    </div>
  )
}

function ProfileHeader({
  handle,
  did,
  isSelf,
  profile,
  followingCount,
  onBack,
  onEdit,
}: {
  handle: string
  did: string
  isSelf: boolean
  profile: ProfileRecord | null
  followingCount: number
  onBack?: () => void
  onEdit?: () => void
}) {
  // Twitter/Bluesky-shape layout: cover banner at the top of the card
  // (full-bleed thanks to the card's overflow-hidden), avatar overlapping
  // the cover's bottom edge with a white ring, then identity row + Edit
  // affordance, then bio. Back lives overlaid on the cover when present
  // (no Back when reached via primary nav from the sidebar).
  return (
    <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
      <div className="relative">
        {profile?.coverURL ? (
          <CoverBanner coverURL={profile.coverURL} contentHash={undefined} />
        ) : (
          // Always-on placeholder so the avatar's overlap has something to
          // overlap. Subtle gradient reads more "intentional empty" than a
          // flat neutral fill.
          <div className="h-32 bg-linear-to-br from-neutral-100 to-neutral-200" />
        )}
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="absolute top-3 left-3 inline-flex items-center px-2.5 py-1 text-xs font-medium text-white bg-black/40 hover:bg-black/60 backdrop-blur-sm rounded-full transition-colors cursor-pointer"
          >
            Back
          </button>
        )}
      </div>
      <div className="px-5 pb-5">
        <div className="flex items-start gap-4">
          {/* -mt-10 lives only on the avatar wrapper so the avatar pulls
              up into the cover; the text column stays in normal flow
              below the cover edge. relative z-10 forces the avatar
              onto a stacking layer above the cover so the overlap
              portion paints on top of the cover image instead of
              under it (the cover container's position:relative would
              otherwise let it cover the avatar's top half). */}
          <div className="relative z-10 -mt-10 rounded-full ring-4 ring-white shrink-0">
            <ProfileAvatar profile={profile} handle={handle} />
          </div>
          <div className="flex-1 min-w-0 flex items-start justify-between gap-3 pt-3">
            <div className="min-w-0 flex items-center gap-5">
              <div className="min-w-0 space-y-0.5">
                <div className="text-lg font-semibold text-neutral-900 truncate">
                  {profile?.displayName || `@${handle}`}
                </div>
                <div className="text-sm text-neutral-500 truncate">
                  @{handle}
                </div>
              </div>
              <Stat value={followingCount} label="Following" />
            </div>
            {isSelf && onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="shrink-0 inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
              >
                {profile ? 'Edit profile' : 'Set up profile'}
              </button>
            )}
            {!isSelf && (
              <div className="shrink-0">
                <FollowHandleButton subjectDID={did} subjectHandle={handle} />
              </div>
            )}
          </div>
        </div>
        {profile?.bio && (
          <p className="text-sm text-neutral-700 whitespace-pre-wrap pt-3">
            {profile.bio}
          </p>
        )}
        {isSelf && !profile && (
          <p className="text-xs text-neutral-400 pt-3">No Pin profile yet.</p>
        )}
      </div>
    </div>
  )
}

function ProfileAvatar({
  profile,
  handle,
}: {
  profile: ProfileRecord | null
  handle: string
}) {
  // Mirrors ChannelAvatar's mark fallback: render bytes if avatarURL is
  // set + resolves; otherwise show a hash-derived letter mark.
  if (profile?.avatarURL) {
    return <AvatarImage avatarURL={profile.avatarURL} handle={handle} />
  }
  return <HandleMark handle={handle} />
}

function AvatarImage({
  avatarURL,
  handle,
}: {
  avatarURL: string
  handle: string
}) {
  // Profile records don't carry a contentHash field today; cache by URL.
  const { url, error } = useItemBlobURL(
    avatarURL,
    'image/jpeg', // mime is just a Blob hint; image element will sniff
    undefined,
  )
  if (error || !url) return <HandleMark handle={handle} />
  return (
    <img
      src={url}
      alt=""
      className="size-20 shrink-0 rounded-full object-cover bg-neutral-100"
    />
  )
}

function CoverBanner({
  coverURL,
  contentHash,
}: {
  coverURL: string
  contentHash: string | undefined
}) {
  const { url, error } = useItemBlobURL(coverURL, 'image/jpeg', contentHash)
  if (error || !url) {
    return <div className="h-32 bg-neutral-100" />
  }
  return (
    <img
      src={url}
      alt=""
      className="w-full h-32 object-cover bg-neutral-100"
    />
  )
}

// Hash-based letter mark for profiles (no cover/avatar fallback).
// Mirrors ChannelMark but seeded by handle.
function HandleMark({ handle }: { handle: string }) {
  const PALETTE: [string, string][] = [
    ['#fee2e2', '#991b1b'],
    ['#fed7aa', '#9a3412'],
    ['#fef3c7', '#854d0e'],
    ['#d9f99d', '#3f6212'],
    ['#bbf7d0', '#14532d'],
    ['#a7f3d0', '#065f46'],
    ['#99f6e4', '#115e59'],
    ['#bae6fd', '#075985'],
    ['#bfdbfe', '#1e40af'],
    ['#c7d2fe', '#3730a3'],
    ['#ddd6fe', '#5b21b6'],
    ['#f5d0fe', '#86198f'],
    ['#fbcfe8', '#9d174d'],
  ]
  let h = 0
  for (let i = 0; i < handle.length; i++) {
    h = (h * 31 + handle.charCodeAt(i)) | 0
  }
  const [bg, fg] = PALETTE[Math.abs(h) % PALETTE.length]
  const letter = (handle.match(/\p{L}/u)?.[0] ?? '?').toUpperCase()
  return (
    <div
      aria-hidden="true"
      style={{ backgroundColor: bg, color: fg }}
      className="size-20 shrink-0 rounded-full flex items-center justify-center text-2xl font-semibold select-none"
    >
      {letter}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wide px-1">
        {title}
      </h2>
      <div className="bg-white border border-neutral-200 rounded-lg divide-y divide-neutral-100">
        {children}
      </div>
    </div>
  )
}

// Total content bytes a channel holds — post bodies + their attachments — from
// the manifest items. Coalesces missing byteSize to 0 (legacy/corrupt items
// undercount rather than NaN-poison the sum). Same number My Storage shows.
function channelContentBytes(manifest: ChannelManifest): number {
  return manifest.items.reduce((sum, item) => {
    const attBytes =
      item.attachments?.reduce((s, a) => s + (a.byteSize ?? 0), 0) ?? 0
    return sum + (item.byteSize ?? 0) + attBytes
  }, 0)
}

function ChannelRow({
  entry,
  showAuthor,
  onChannelClick,
  onHandleClick,
}: {
  entry: ChannelEntry
  showAuthor: boolean
  onChannelClick: (authorHandle: string, channelID: string) => void
  onHandleClick: (handle: string) => void
}) {
  const onRowClick = () =>
    onChannelClick(entry.authorHandle, entry.channelID)
  const onAuthorClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onHandleClick(entry.authorHandle)
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: row contains a nested @handle button, which would nest interactives inside a <button>
    <div
      role="button"
      tabIndex={0}
      onClick={onRowClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onRowClick()
        }
      }}
      className="p-3 flex gap-3 items-start hover:bg-neutral-50 cursor-pointer transition-colors"
    >
      <ChannelAvatar
        channelID={entry.channelID}
        channelName={entry.manifest.name}
        authorHandle={entry.authorHandle}
        avatar={entry.manifest.avatar}
        size="md"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-neutral-900 truncate">
          {entry.manifest.name}
        </div>
        {showAuthor && entry.authorHandle && (
          <button
            type="button"
            onClick={onAuthorClick}
            className="block max-w-full text-xs text-neutral-500 truncate hover:underline cursor-pointer text-left"
          >
            @{entry.authorHandle}
          </button>
        )}
        {entry.manifest.description && (
          <div className="text-sm text-neutral-700 truncate pt-0.5">
            {entry.manifest.description}
          </div>
        )}
      </div>
    </div>
  )
}
