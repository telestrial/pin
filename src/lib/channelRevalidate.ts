// The out-of-band manifest-update path: how a channel manifest that arrives
// WITHOUT a user-initiated read gets into the feed.
//
// It exists because of the resolution ladder's own shape. Reads are fast now
// because they serve the shared-doc cache (step 3), which means the read itself
// never notices that the author published something new — it hands back what it
// already had. So something else has to check in the background and fill the feed
// in when the content actually moved. That's this module.
//
// The split into two functions is deliberate. `applyIfChanged` is the fill-in;
// `revalidateSubscribedChannel` is check-then-fill-in. The eager pull loop is the
// FIRST caller, not the only intended one: ladder rung 1 (live-sync a subscribed
// author's channel from their node) receives a manifest already in hand and calls
// `applyIfChanged` directly, no resolve. A polled manifest and a pushed one land
// by the same path.

import type { ChannelManifest, SubscriptionRef } from '../core/types'
import { useFeedStore } from '../stores/feed'
import { cacheSubscribedChannel } from './channelLocator'

/** Push a manifest into the feed IF it differs from what the store already holds.
 *  Returns whether it applied.
 *
 *  Compared by serialization: both sides are parsed from the author's own
 *  `JSON.stringify(manifest)`, so key order matches and re-stringifying is a
 *  faithful equality. That matters — a spurious "changed" would rebuild the
 *  channel's entries (new array identities → a feed re-render) on every quiet
 *  pass. Manifests are KBs; the compare is cheap.
 *
 *  A channel the store doesn't know yet counts as changed, so a background pass
 *  can populate a channel the feed hasn't loaded rather than sit on it. */
export function applyIfChanged(
  sub: SubscriptionRef,
  manifest: ChannelManifest,
): boolean {
  const feed = useFeedStore.getState()
  const existing = feed.manifests[sub.channelID]
  if (existing && JSON.stringify(existing) === JSON.stringify(manifest)) {
    return false
  }
  feed.applyManifest(sub, manifest)
  return true
}

/** Check-then-fill-in for one subscribed channel: resolve it fresh (which also
 *  re-warms the `sub/<channelID>` cache the reader serves), then apply to the feed
 *  only if the content actually moved. Returns whether the feed changed.
 *
 *  Never throws — the caller is a background loop, and an unresolvable channel
 *  (DHT lag, author offline) is an ordinary outcome, not an error to surface. The
 *  feed keeps its last-known content in that case. */
export async function revalidateSubscribedChannel(
  appKeyHex: string,
  sub: SubscriptionRef,
): Promise<boolean> {
  const manifest = await cacheSubscribedChannel(
    appKeyHex,
    sub.channelID,
    sub.channelKey,
  )
  if (!manifest) return false
  return applyIfChanged(sub, manifest)
}
