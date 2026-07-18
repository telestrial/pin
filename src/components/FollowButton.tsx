import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'

// Follow a single channel — the iroh-native public edge. Writes a FollowEdge
// {didDht, channelID, name} to local settings (mirrored into the identity-doc
// by useIdentityDocPublish); carries no K. No atproto, no round-trip: the
// follow state is a synchronous read of the local store.
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

  function handleClick() {
    if (following) {
      removeFollow(channelID)
      addToast(`Unfollowed “${channelName}”`)
    } else {
      addFollow({ didDht: authorDidDht, channelID, name: channelName })
      addToast(`Following “${channelName}”`)
    }
  }

  // Following = filled green (matches the brand-green PinButton-pinned
  // state). Not-following = neutral pill that turns green on hover.
  const className = following
    ? 'inline-flex items-center px-2.5 py-1 text-xs font-medium text-white bg-green-600 hover:bg-green-700 rounded-full transition-colors cursor-pointer'
    : 'inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-700 hover:text-white bg-neutral-100 hover:bg-green-600 rounded-full transition-colors cursor-pointer'

  return (
    <button type="button" onClick={handleClick} className={className}>
      {following ? 'Following' : 'Follow'}
    </button>
  )
}
