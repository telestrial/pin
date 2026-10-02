import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { content_key_collection } from '../../crates/pin-core/pkg/pin_core.js'
import type { ChannelManifest } from '../core/types'
import { ensureWasm } from '../core/wasm'
import { resolveChannelViaLocator } from '../lib/channelLocator'
import { subscribeDocChanges } from '../lib/docs'
import { useIdentityName } from '../lib/hooks/useIdentityName'
import { type Invitation, useInvitations } from '../lib/hooks/useInvitations'
import { startWatching } from '../lib/watch'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { ChannelAvatar } from './channel/ChannelAvatar'

/** Invitations to Secret channels, offered in the sidebar until each is answered.
 *
 *  Rendered only when something is pending: an empty section here would be a permanent
 *  heading for a thing most people never receive. An invitation is shown, never joined
 *  automatically — accepting is watching the channel, with the key the invitation
 *  carried. */
export function Invitations() {
  const pending = useInvitations()
  if (pending.length === 0) return null
  return (
    <section className="space-y-2 mt-6">
      <h2 className="px-3 text-xs font-semibold tracking-wide uppercase text-neutral-500">
        Invitations
      </h2>
      <ul aria-label="Invitations to channels">
        {pending.map((i) => (
          <InvitationRow key={i.channelID} invitation={i} />
        ))}
      </ul>
    </section>
  )
}

// What each invitation opened to this session, so the sidebar remounting on every
// navigation does not resolve the channel again.
const opened = new Map<string, ChannelManifest>()

/** The channel an invitation is for, once it can be read, or null before.
 *
 *  It cannot be read until the Curator has climbed to the channel's key, which happens on
 *  its pull pass after the membership lands — so a read that fails is tried again when a
 *  key for this channel is written, rather than taken as the channel being unreadable. */
function useInvitedChannel(i: Invitation): ChannelManifest | null {
  const { channelID } = i
  const { channelKey, author } = i.membership
  const [manifest, setManifest] = useState(() => opened.get(channelID) ?? null)

  useEffect(() => {
    if (opened.has(channelID)) return
    let cancelled = false
    let unsub: (() => void) | undefined
    const attempt = () =>
      resolveChannelViaLocator(channelKey, author)
        .then((m) => {
          // Nothing resolvable yet reads like a key not climbed to: try again later.
          if (!m) return
          opened.set(channelID, m)
          if (!cancelled) setManifest(m)
          unsub?.()
        })
        .catch(() => {})
    void (async () => {
      await ensureWasm()
      if (cancelled) return
      const collection = content_key_collection()
      const prefix = `${channelID}:`
      unsub = subscribeDocChanges(({ collection: c, rkey }) => {
        if (c === collection && rkey.startsWith(prefix)) void attempt()
      })
      await attempt()
    })()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [channelID, channelKey, author])

  return manifest
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const { channelID, membership } = invitation
  const manifest = useInvitedChannel(invitation)
  const authorName = useIdentityName(membership.author)
  const dismiss = useAuthStore((s) => s.dismissInvitation)
  const addToast = useToastStore((s) => s.addToast)
  const [accepting, setAccepting] = useState(false)
  const name = manifest?.name ?? 'A secret channel'

  async function accept() {
    if (!manifest) return
    setAccepting(true)
    try {
      await startWatching({
        authorHandle: '',
        didDht: membership.author,
        channelID,
        channelKey: membership.channelKey,
        manifest,
      })
      addToast(`Joined “${manifest.name}”`)
    } catch (err) {
      addToast(`Couldn’t join: ${String(err)}`)
    } finally {
      setAccepting(false)
    }
  }

  return (
    <li className="px-3 py-1.5 flex items-center gap-2">
      <ChannelAvatar
        channelID={channelID}
        channelName={name}
        authorHandle=""
        avatar={manifest?.avatar}
        size="xs"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-neutral-800 truncate">{name}</div>
        <div className="text-xs text-neutral-500 truncate">
          {manifest ? `from @${authorName}` : `from @${authorName} · opening…`}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void accept()}
        disabled={!manifest || accepting}
        title={manifest ? 'Accept' : 'Waiting for the channel to open'}
        aria-label={`Accept the invitation to ${name}`}
        className="p-1 text-neutral-400 hover:text-green-700 disabled:opacity-40 disabled:hover:text-neutral-400 transition-colors cursor-pointer"
      >
        <Check className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => dismiss(channelID)}
        title="Dismiss"
        aria-label={`Dismiss the invitation to ${name}`}
        className="p-1 text-neutral-400 hover:text-neutral-900 transition-colors cursor-pointer"
      >
        <X className="size-4" />
      </button>
    </li>
  )
}
