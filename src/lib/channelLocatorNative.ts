// The channel round-trip, as reached from the browser.
//
// Thin wrappers over pin-core, whose sequencing lives in `pin_channel` so the Curator
// can resolve subscribed channels natively for its pull loop without that sequence being
// written twice. Sealing under K, uploading the bytes, deriving the locator from K and
// signing the pointer is an ORDER whose steps are individually meaningless — publish the
// pointer before the bytes land and a reader resolves to nothing — which is why it moved
// as a unit rather than as pieces.
//
// This module exists as a module, rather than callers reaching pin-core directly, so the
// integration tier has something to intercept. Both halves of the round-trip are internal
// to Rust now: it uses the Rust Sia session, not the `SiaClient` the tests inject, and it
// talks to pkarr itself. So neither of the old interception points reaches it, and a fake
// has to stand in at this boundary — the whole round-trip — or not at all.

import {
  channel_open_blob,
  channel_publish,
  channel_republish_pointer,
  channel_resolve,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'

/** Where a published manifest ended up. `objectId` is what the caller reclaims when it
 *  supersedes a generation — the pointer takes seconds to propagate, so the previous
 *  object has to outlive the publish. */
export type PublishedLocator = {
  locatorKey: string
  objectId: string
  itemURL: string
}

/** A resolved channel: the manifest's JSON, plus the exact blob it was sealed in so a
 *  caller can cache that blob verbatim. */
export type ResolvedLocator = { manifestJson: string; blob: string }

/** Seal a manifest under K, upload it, and sign the pointer. */
export async function publishLocator(
  channelKey: Uint8Array,
  manifestJson: string,
): Promise<PublishedLocator> {
  await ensureWasm()
  return JSON.parse(
    await channel_publish(channelKey, manifestJson),
  ) as PublishedLocator
}

/** Read a channel from K alone. Null when the locator resolves to nothing — the channel
 *  may never have been published, or its record may have aged off the DHT. */
export async function resolveLocator(
  channelKey: Uint8Array,
): Promise<ResolvedLocator | null> {
  await ensureWasm()
  const json = await channel_resolve(channelKey)
  return json === undefined ? null : (JSON.parse(json) as ResolvedLocator)
}

/** Re-sign a channel's current pointer to refresh its TTL, minting no new object. */
export async function republishPointer(
  channelKey: Uint8Array,
  itemURL: string,
): Promise<void> {
  await ensureWasm()
  return channel_republish_pointer(channelKey, itemURL)
}

/** Open a sealed manifest blob with K, returning its JSON. The path a CACHED copy takes,
 *  so a cached read and a fresh resolve decode through the same code. */
export async function openBlob(
  channelKey: Uint8Array,
  blob: string,
): Promise<string> {
  await ensureWasm()
  return channel_open_blob(channelKey, blob)
}
