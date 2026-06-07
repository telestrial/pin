import { useEffect, useState } from 'react'
import { isFollowing } from '../core/follow'
import { useAuthStore } from '../stores/auth'

// Claim state for one of YOUR public channels: are you publicly self-following
// it — i.e. is it advertised under "Voices" on your profile. `null` means
// unknown / not-applicable (not your channel, not public, or the check hasn't
// resolved yet). Lifted out of ChannelOwnerMenu so the header "Unclaimed"
// badge and the menu's Unclaim/Reclaim item share one source of truth and
// stay in sync across a toggle.
export function useChannelClaim(
  channelAuthorDID: string | undefined,
  channelID: string,
  enabled: boolean,
): { claimed: boolean | null; setClaimed: (v: boolean) => void } {
  const myDID = useAuthStore((s) => s.atprotoDID)
  const [claimed, setClaimed] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!enabled || !myDID || !channelAuthorDID) {
      setClaimed(null)
      return
    }
    isFollowing(myDID, channelAuthorDID, channelID)
      .then((v) => {
        if (!cancelled) setClaimed(v)
      })
      .catch(() => {
        // Treat an unfamiliar error as "unknown" rather than guessing a state.
        if (!cancelled) setClaimed(null)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, myDID, channelAuthorDID, channelID])

  return { claimed, setClaimed }
}
