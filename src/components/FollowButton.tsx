import { useState } from 'react'
import {
  unwatchOneChannel,
  watchOneChannel,
} from '../lib/hooks/useHandleFollowReconciliation'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

// Follow a single channel — the iroh-native public edge. Writes a FollowEdge
// {didDht, channelID, name} to local settings (mirrored into the identity-doc
// by useIdentityDocPublish); carries no K.
//
// Following also WATCHES it, so the channel lands in your feed. It used to do
// neither: the edge carries no K, so following said something publicly and gave
// the follower nothing, which nobody would guess from a button labelled Follow.
// K comes from the author's directory, which is where the person-follow path
// already reads it — public channels advertise it, which is what public means.
//
// So the two relations split by what they are FOR rather than by what they
// fetch: Follow is public and gets you the channel; Watch is private, comes
// from a link, and works for unlisted channels a directory never names.
//
// Renders for public channels whose manifest carries the author's did:dht (the
// caller gates on that + on ownership — only mounted on non-owned channels).
export function FollowButton({
  authorDidDht,
  channelID,
  channelName,
}: {
  authorDidDht: string
  channelID: string
  channelName: string
}) {
  const following = useAuthStore((s) =>
    s.follows.some((f) => f.channelID === channelID),
  )
  const addFollow = useAuthStore((s) => s.addFollow)
  const removeFollow = useAuthStore((s) => s.removeFollow)
  const addToast = useToastStore((s) => s.addToast)

  // The edge toggles synchronously against the local store; busy covers the
  // watch side-effect, which resolves the author's directory for K.
  const [busy, setBusy] = useState(false)

  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      if (following) {
        removeFollow(channelID)
        await unwatchOneChannel(channelID).catch(() => false)
        addToast(`Unfollowed “${channelName}”`)
      } else {
        addFollow({ didDht: authorDidDht, channelID, name: channelName })
        // A follow stands whether or not the watch lands: the edge is the public
        // statement, and a directory that would not resolve is a reason the
        // channel is not readable yet rather than a reason not to have followed.
        const watched = await watchOneChannel(authorDidDht, channelID).catch(
          () => false,
        )
        addToast(
          watched
            ? `Following “${channelName}” · added to your feed`
            : `Following “${channelName}”`,
        )
      }
    } finally {
      setBusy(false)
    }
  }

  // Following = filled green (matches the brand-green PinButton-pinned
  // state). Not-following = neutral pill that turns green on hover.
  const label = busy
    ? following
      ? 'Unfollowing…'
      : 'Following…'
    : following
      ? 'Following'
      : 'Follow'

  const className = following
    ? 'inline-flex items-center px-2.5 py-1 text-xs font-medium text-white bg-green-600 hover:bg-green-700 rounded-full transition-colors cursor-pointer disabled:opacity-60'
    : 'inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-700 hover:text-white bg-neutral-100 hover:bg-green-600 rounded-full transition-colors cursor-pointer disabled:opacity-60'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={className}
    >
      {label}
    </button>
  )
}
