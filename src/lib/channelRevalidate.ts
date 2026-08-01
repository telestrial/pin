// The out-of-band manifest-update path: how a channel manifest that arrives
// WITHOUT a user-initiated read gets into the feed.
//
// It exists because of the resolution ladder's own shape. Reads are fast now
// because they serve the shared-doc cache (step 3), which means the read itself
// never notices that the author published something new — it hands back what it
// already had. So something else has to check in the background and fill the feed
// in when the content actually moved. That's this module.
//
// The split into two functions is deliberate. `applyIfChanged` is the fill-in itself;
// `applyCachedChannel` is read-then-fill-in, for when a cached record has moved. The
// pull loop is the first caller of the second, not the only intended one: ladder rung 1
// (live-sync of a subscribed author's channel doc) receives a manifest already in hand
// and calls `applyIfChanged` directly, no read. A polled manifest and a pushed one land
// by the same path.

import { channelKeyFromBase64 } from '../core/crypto'
import type { ChannelManifest, SubscriptionRef } from '../core/types'
import { useFeedStore } from '../stores/feed'
import { decodeChannelManifest } from './channelLocator'
import { getRecord } from './docs'

/** The collection the Curator's pull loop caches subscribed manifests into. Must
 *  match `SUB_COLLECTION` in crates/pin-curator. */
const SUB_COLLECTION = 'sub'

/** Push a manifest into the feed IF it differs from what the store already holds AND
 *  isn't older than it. Returns whether it applied.
 *
 *  Compared by serialization: both sides are parsed from the author's own
 *  `JSON.stringify(manifest)`, so key order matches and re-stringifying is a
 *  faithful equality. That matters — a spurious "changed" would rebuild the
 *  channel's entries (new array identities → a feed re-render) on every quiet
 *  pass. Manifests are KBs; the compare is cheap.
 *
 *  A channel the store doesn't know yet counts as changed, so a background pass
 *  can populate a channel the feed hasn't loaded rather than sit on it.
 */
export function applyIfChanged(
  sub: SubscriptionRef,
  manifest: ChannelManifest,
): boolean {
  const feed = useFeedStore.getState()
  const existing = feed.manifests[sub.channelID]
  if (existing && JSON.stringify(existing) === JSON.stringify(manifest)) {
    return false
  }
  if (existing && manifest.publishedAt < existing.publishedAt) return false
  feed.applyManifest(sub, manifest)
  return true
}

/** Read a subscribed channel's cached manifest out of the doc and land it in the feed.
 *  Returns whether the feed changed.
 *
 *  This is what makes the Curator's pull loop visible. The loop writes
 *  `sub/<channelID>` and stops there — deliberately, so that it doesn't depend on a UI
 *  existing — and this is the other side of that: the change feed says a record moved,
 *  and this turns the record into what's on screen.
 *
 *  Never throws. The value may not have finished downloading (iroh-blobs content lags
 *  its entry), which is ordinary rather than exceptional; a later event re-reads it. */
export async function applyCachedChannel(
  sub: SubscriptionRef,
): Promise<boolean> {
  try {
    const cached = await getRecord(SUB_COLLECTION, sub.channelID)
    if (!cached) return false
    const manifest = await decodeChannelManifest(
      channelKeyFromBase64(sub.channelKey),
      cached,
    )
    return applyIfChanged(sub, manifest)
  } catch {
    return false
  }
}
