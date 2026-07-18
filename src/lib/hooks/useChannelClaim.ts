import { useAuthStore } from '../../stores/auth'

// Claim state for one of YOUR public channels: is it advertised in your
// identity-doc — i.e. shown under "Voices" on your profile. Local + synchronous
// now: the `advertised` flag lives on the owned channel (settings-synced), no
// atproto. `null` = not applicable (not enabled, or not one of yours). Keeps the
// header "Unclaimed" badge and the menu's Unclaim/Reclaim item on one source of
// truth so they stay in sync across a toggle.
export function useChannelClaim(
  channelID: string,
  enabled: boolean,
): { claimed: boolean | null; setClaimed: (v: boolean) => void } {
  const claimed = useAuthStore((s) => {
    if (!enabled) return null
    const c = s.myChannels.find((x) => x.channelID === channelID)
    return c ? c.advertised !== false : null
  })
  const setChannelAdvertised = useAuthStore((s) => s.setChannelAdvertised)
  return {
    claimed,
    setClaimed: (v: boolean) => setChannelAdvertised(channelID, v),
  }
}
