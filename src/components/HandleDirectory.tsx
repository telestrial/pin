import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { advertisedChannels } from '../core/channels'
import type { ProfileRecord } from '../core/profile'
import type { ChannelManifest, FollowEdge } from '../core/types'
import {
  readOwnManifest,
  resolveChannelViaLocator,
} from '../lib/channelLocator'
import { formatBytes } from '../lib/format'
import { useItemBlobURL } from '../lib/hooks/useItemBytes'
import { resolveIdentityDoc } from '../lib/identityDoc'
import { useAuthStore } from '../stores/auth'
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
      // Channel-follows from the identity-doc (did:dht + channelID + cached
      // name, no K). Lightweight rows — they link to the author's directory
      // rather than opening the channel directly (viewing needs K, which a
      // follow edge doesn't carry).
      follows: FollowEdge[]
    }
  | { kind: 'error'; message: string }

/** This identity's own directory, out of local state.
 *
 *  The same three parts a resolved one has, from the sources the publisher reads: settings
 *  for the profile, the advertised set and the follows, and the doc for each manifest. A
 *  manifest that isn't in the doc yet is SKIPPED rather than resolved — the record is
 *  written as part of the commit that publishes a channel, so its absence means a channel
 *  this device has not synced, and one missing hero card is a better answer than a network
 *  round trip on a screen that is otherwise instant. */
async function readOwnDirectory(): Promise<{
  profile: ProfileRecord | null
  ownChannels: ChannelEntry[]
  follows: FollowEdge[]
}> {
  const { profile, myChannels, follows, storedKeyHex } = useAuthStore.getState()
  const advertised = advertisedChannels(myChannels)
  const resolved = storedKeyHex
    ? await Promise.all(
        advertised.map(async (c): Promise<ChannelEntry | null> => {
          const manifest = await readOwnManifest(
            storedKeyHex,
            c.channelID,
            c.channelKey,
          )
          return manifest
            ? {
                authorDID: '',
                authorHandle: '',
                channelID: c.channelID,
                manifest,
              }
            : null
        }),
      )
    : []
  return {
    profile,
    ownChannels: resolved.filter((c): c is ChannelEntry => c !== null),
    follows,
  }
}

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
  const myDidDht = useAuthStore((s) => s.myDidDht)
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
      // Identities are did:dht now — resolve the identity-doc off atproto
      // (pkarr → Sia): profile + advertised public channels (each via its
      // locator) + the channel-follow edges. A non-did:dht handle (a legacy
      // pre-cutover channel/sub that never got a did:dht) simply doesn't
      // resolve — replace-don't-bridge.
      if (!handle.startsWith('did:dht:')) {
        if (!cancelled) setState({ kind: 'not-found' })
        return
      }
      const client = useAuthStore.getState().client
      if (!client) {
        if (!cancelled) setState({ kind: 'not-found' })
        return
      }
      // YOUR OWN directory is assembled here rather than resolved. Every part of it is
      // something the Curator publishes FROM: the profile, the advertised set and the
      // follow edges are settings, and each manifest is in the doc under `channel/<id>`.
      // So resolving your own did:dht spends a DHT lookup and a Sia download to learn
      // what this process already holds — and worse, it shows what was last PUBLISHED, so
      // a channel you created a minute ago is missing from your own profile until the
      // identity loop's next pass.
      //
      // What this gives up is that your profile page no longer doubles as proof that the
      // publish is working. That belongs on the Curate page, which reports the identity
      // loop's every pass, rather than being inferred from a screen that has another job.
      if (handle === useAuthStore.getState().myDidDht) {
        const local = await readOwnDirectory()
        if (!cancelled) setState({ kind: 'loaded', did: handle, ...local })
        return
      }

      const doc = await resolveIdentityDoc(client, handle)
      if (!doc) {
        if (!cancelled) setState({ kind: 'not-found' })
        return
      }
      const resolved = await Promise.all(
        doc.channels.map(async (c): Promise<ChannelEntry | null> => {
          try {
            const manifest = await resolveChannelViaLocator(c.key)
            return manifest
              ? {
                  authorDID: '',
                  authorHandle: '',
                  channelID: c.channelID,
                  manifest,
                }
              : null
          } catch {
            return null
          }
        }),
      )
      if (!cancelled) {
        setState({
          kind: 'loaded',
          did: handle,
          profile: doc.profile,
          ownChannels: resolved.filter((c): c is ChannelEntry => c !== null),
          follows: doc.follows,
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

  const isSelf = !!myDidDht && myDidDht === handle
  // A did:dht is a long key; show a short readable form in the status/heading
  // copy (`did:dht:…db4o`), falling back to the raw value for anything else.
  const shortHandle = handle.startsWith('did:dht:')
    ? `did:dht:…${handle.replace(/^did:dht:/, '').slice(-6)}`
    : handle

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
    <div className="flex-1 p-6 lg:min-h-0">
      <div className="flex flex-col gap-6 lg:h-full lg:min-h-0 lg:flex-row lg:items-start">
        {sidebar}
        <div className="flex-1 min-w-0 space-y-5 lg:max-h-full lg:overflow-y-auto">
          {state.kind === 'loading' && (
            <div className="bg-white border border-neutral-200 rounded-lg p-5 flex flex-col gap-4">
              {inlineBackButton}
              <p className="text-center text-sm text-neutral-500">
                Loading {shortHandle}…
              </p>
            </div>
          )}

          {state.kind === 'not-found' && (
            <div className="bg-white border border-neutral-200 rounded-lg p-5 flex flex-col gap-4">
              {inlineBackButton}
              <div className="text-center space-y-2">
                <h1 className="text-lg font-semibold text-neutral-900">
                  {shortHandle}
                </h1>
                <p className="text-sm text-neutral-500">
                  That identity doesn't resolve.
                </p>
              </div>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="bg-white border border-neutral-200 rounded-lg p-5 flex flex-col gap-4">
              {inlineBackButton}
              <div className="text-center space-y-2">
                <h1 className="text-lg font-semibold text-neutral-900">
                  {shortHandle}
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
              follows={state.follows}
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
  follows,
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
  follows: FollowEdge[]
  onBack?: () => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  onHandleClick: (handle: string) => void
  onEditProfile?: () => void
  onCreate?: () => void
}) {
  const isEmpty = !profile && ownChannels.length === 0 && follows.length === 0

  return (
    <div className="space-y-5">
      <ProfileHeader
        handle={handle}
        did={did}
        isSelf={isSelf}
        profile={profile}
        followingCount={follows.length}
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

      {follows.length > 0 && (
        <Section title="Following">
          {follows.map((f) => (
            <FollowRow
              key={`${f.didDht}:${f.channelID}`}
              edge={f}
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
  // The identity is a did:dht key — show a short, readable form
  // (`did:dht:…db4o`) as the fallback label when there's no chosen @name.
  const handleLabel = `did:dht:…${handle.replace(/^did:dht:/, '').slice(-6)}`
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
                  {profile?.displayName ||
                    (profile?.username
                      ? `@${profile.username}`
                      : `@${handleLabel}`)}
                </div>
                {/* The chosen @-name is what people read; there's no atproto
                    address underneath anymore, so no suffix — just the @-name
                    (or the short did fallback when unnamed). */}
                <div className="text-sm text-neutral-500 truncate">
                  @{profile?.username || handleLabel}
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
            {/* Handle-follow: follow the whole person (their did:dht) — an
                iroh edge in local settings + the identity-doc. Shown on
                another person's identity. */}
            {!isSelf && (
              <div className="shrink-0">
                <FollowHandleButton
                  subjectDidDht={did}
                  subjectHandle={profile?.username ?? handleLabel}
                />
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
    <img src={url} alt="" className="w-full h-32 object-cover bg-neutral-100" />
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

// A channel-follow edge (did:dht + channelID + cached name, no K). Lightweight
// row — clicking navigates to the author's directory (viewing the channel
// directly needs K, which a follow edge doesn't carry), where the channel
// resolves properly from the advertised list.
function FollowRow({
  edge,
  onHandleClick,
}: {
  edge: FollowEdge
  onHandleClick: (handle: string) => void
}) {
  const name = edge.name || 'Channel'
  return (
    <button
      type="button"
      onClick={() => onHandleClick(edge.didDht)}
      className="w-full p-3 flex gap-3 items-center text-left hover:bg-neutral-50 cursor-pointer transition-colors"
    >
      <ChannelAvatar
        channelID={edge.channelID}
        channelName={name}
        authorHandle=""
        size="md"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-neutral-900 truncate">
          {name}
        </div>
      </div>
    </button>
  )
}
