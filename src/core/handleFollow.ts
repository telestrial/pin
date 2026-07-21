import type { SubscriptionRef } from './types'

// Pure reconciliation logic for handle-follow auto-Watch. The network side
// (resolving a followed identity's advertised channels, writing the local
// edges) lives in useHandleFollowReconciliation; these are the set-math halves.

// The additive half. Given the channels claimed across all the people you
// handle-follow (already resolved to Watch candidates), the channelIDs you
// currently hold locally, and your tombstone set, return the candidates to
// auto-Watch now: claimed, not already present, not tombstoned. Deduped by
// channelID (a channel reached via two followed people is added once).
// Reconcile is additive only — it never removes; the tombstone set is how an
// explicit unsubscribe survives repeated boots.
export function autoWatchAdditions(
  candidates: readonly SubscriptionRef[],
  subscribedChannelIDs: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
): SubscriptionRef[] {
  const out: SubscriptionRef[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    if (subscribedChannelIDs.has(c.channelID)) continue
    if (dismissed.has(c.channelID)) continue
    if (seen.has(c.channelID)) continue
    seen.add(c.channelID)
    out.push(c)
  }
  return out
}

// The removal half, applied at unfollow time: of the channels the unfollowed
// person currently claims, which ones do we hold and should sweep out of our
// Watches. Pure intersection — the caller re-walks the unfollowed person's
// claimed channels to source `theirClaimedChannelIDs`.
export function autoWatchRemovals(
  theirClaimedChannelIDs: readonly string[],
  subscribedChannelIDs: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of theirClaimedChannelIDs) {
    if (!subscribedChannelIDs.has(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
