import { AtpAgent } from '@atproto/api'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchChannel } from '../core/channels'
import { listFollows, parseChannelAtURI } from '../core/follow'
import { getProfileRecord, type ProfileRecord } from '../core/profile'
import type { ChannelManifest } from '../core/types'
import { useItemBlobURL } from '../lib/useItemBytes'
import { useAuthStore } from '../stores/auth'
import { ChannelAvatar } from './ChannelAvatar'

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

export function HandleDirectory() {
  const params = useParams<{ handle: string }>()
  const navigate = useNavigate()
  const myHandle = useAuthStore((s) => s.atprotoHandle)
  const [state, setState] = useState<State>({ kind: 'loading' })

  // Defensive normalize: route is /@:handle so `handle` is the bit after
  // the leading @, but a user pasting /@@john would slip a second @ into
  // the param. Strip leading @'s before any network call.
  const handle = (params.handle ?? '').replace(/^@+/, '')

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
      // Sequential to keep the request burst small for a first cut; could
      // parallelize later. Obscure channels in the follow list (which the
      // Follow UI gates against, so this is mostly belt-and-suspenders)
      // will fail fetchChannel with no record.key + no caller key, and we
      // silently drop them.
      const channels: ChannelEntry[] = []
      for (const f of follows) {
        const parsed = parseChannelAtURI(f.record.subject)
        if (!parsed) continue
        try {
          const manifest = await fetchChannel(parsed.authorDID, parsed.channelID)
          let authorHandle = ''
          try {
            const r = await unauthed.com.atproto.repo.describeRepo({
              repo: parsed.authorDID,
            })
            authorHandle = r.data.handle
          } catch {
            // Best-effort; row still renders with empty handle.
          }
          channels.push({
            authorDID: parsed.authorDID,
            authorHandle,
            channelID: parsed.channelID,
            manifest,
          })
        } catch {
          // Skip unreadable channels (obscure without K, network failures,
          // etc.). Don't break the whole page over one bad row.
        }
      }

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

  return (
    <div className="flex-1 p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="bg-neutral-100 hover:bg-neutral-200 rounded-full px-2.5 py-1 text-xs text-neutral-700 transition-colors"
        >
          Back to feed
        </button>

        {state.kind === 'loading' && (
          <div className="bg-white border border-neutral-200 rounded-lg p-8 text-center text-sm text-neutral-500">
            Loading @{handle}…
          </div>
        )}

        {state.kind === 'not-found' && (
          <div className="bg-white border border-neutral-200 rounded-lg p-8 text-center space-y-2">
            <h1 className="text-lg font-semibold text-neutral-900">
              @{handle}
            </h1>
            <p className="text-sm text-neutral-500">
              That handle doesn't resolve to an atproto identity.
            </p>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="bg-white border border-neutral-200 rounded-lg p-8 text-center space-y-2">
            <h1 className="text-lg font-semibold text-neutral-900">
              @{handle}
            </h1>
            <p className="text-sm text-red-600">
              Failed to load: {state.message}
            </p>
          </div>
        )}

        {state.kind === 'loaded' && (
          <LoadedDirectory
            handle={handle}
            isSelf={isSelf}
            profile={state.profile}
            ownChannels={state.ownChannels}
            followedChannels={state.followedChannels}
          />
        )}
      </div>
    </div>
  )
}

function LoadedDirectory({
  handle,
  isSelf,
  profile,
  ownChannels,
  followedChannels,
}: {
  handle: string
  isSelf: boolean
  profile: ProfileRecord | null
  ownChannels: ChannelEntry[]
  followedChannels: ChannelEntry[]
}) {
  const isEmpty =
    !profile && ownChannels.length === 0 && followedChannels.length === 0

  return (
    <>
      <ProfileHeader handle={handle} isSelf={isSelf} profile={profile} />

      {isEmpty && (
        <div className="bg-white border border-neutral-200 rounded-lg p-8 text-center text-sm text-neutral-500">
          No Pin profile yet.
        </div>
      )}

      {ownChannels.length > 0 && (
        <Section title={isSelf ? 'Your voices' : 'Their voices'}>
          {ownChannels.map((c) => (
            <ChannelRow
              key={`${c.authorDID}:${c.channelID}`}
              entry={c}
              showAuthor={false}
            />
          ))}
        </Section>
      )}

      {followedChannels.length > 0 && (
        <Section title="Following">
          {followedChannels.map((c) => (
            <ChannelRow
              key={`${c.authorDID}:${c.channelID}`}
              entry={c}
              showAuthor
            />
          ))}
        </Section>
      )}
    </>
  )
}

function ProfileHeader({
  handle,
  isSelf,
  profile,
}: {
  handle: string
  isSelf: boolean
  profile: ProfileRecord | null
}) {
  return (
    <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
      {profile?.coverURL && (
        <CoverBanner
          coverURL={profile.coverURL}
          contentHash={undefined}
        />
      )}
      <div className="p-5 flex gap-4 items-start">
        <ProfileAvatar profile={profile} handle={handle} />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="text-lg font-semibold text-neutral-900 truncate">
            {profile?.displayName || `@${handle}`}
          </div>
          <div className="text-sm text-neutral-500 truncate">@{handle}</div>
          {profile?.bio && (
            <p className="text-sm text-neutral-700 whitespace-pre-wrap pt-1">
              {profile.bio}
            </p>
          )}
          {isSelf && (
            <p className="text-xs text-neutral-400 pt-1">
              {profile ? 'This is your profile.' : 'No Pin profile yet.'}
            </p>
          )}
        </div>
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
      className="size-16 shrink-0 rounded-full object-cover bg-neutral-100"
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
      className="size-16 shrink-0 rounded-full flex items-center justify-center text-2xl font-semibold select-none"
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

function ChannelRow({
  entry,
  showAuthor,
}: {
  entry: ChannelEntry
  showAuthor: boolean
}) {
  return (
    <div className="p-3 flex gap-3 items-start">
      <ChannelAvatar
        channelID={entry.channelID}
        channelName={entry.manifest.name}
        authorHandle={entry.authorHandle}
        coverArt={entry.manifest.coverArt}
        size="md"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-neutral-900 truncate">
          {entry.manifest.name}
        </div>
        {showAuthor && entry.authorHandle && (
          <div className="text-xs text-neutral-500 truncate">
            @{entry.authorHandle}
          </div>
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
