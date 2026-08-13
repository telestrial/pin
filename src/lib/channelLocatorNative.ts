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
//
// It also FORKS BY PLATFORM, and must: the connected Sia session lives wherever the app
// put it, and on desktop that is the native backend, not the WebView. `connectSiaClient`
// hands the AppKey to Tauri there and never connects the wasm session, so reaching the
// wasm round-trip on desktop fails instantly with "Sia is not connected" — which is
// exactly how it broke when this first shipped. Running it natively also gives both halves
// the better transport: native QUIC for the Sia object, and the Mainline DHT directly for
// the pointer instead of relays whose read-after-write lag runs to minutes.
//
// `openBlob` does NOT fork. It is pure AES over bytes the caller already holds — no
// session, no network — so the wasm path is correct on both platforms.

import {
  channel_fetch_tallies,
  channel_open_blob,
  channel_publish,
  channel_republish_pointer,
  channel_resolve,
  channel_resolve_tallies_url,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import { inTauri } from './openExternal'

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

/** The session-bound half of the round-trip, per platform. */
interface ChannelLocatorTransport {
  publishLocator(
    channelKey: Uint8Array,
    manifestJson: string,
  ): Promise<PublishedLocator>
  resolveLocator(channelKey: Uint8Array): Promise<ResolvedLocator | null>
  republishPointer(channelKey: Uint8Array, itemURL: string): Promise<void>
  resolveTalliesUrl(channelKey: Uint8Array): Promise<string | null>
  fetchTallies(channelKey: Uint8Array, itemURL: string): Promise<string>
}

let transportP: Promise<ChannelLocatorTransport> | null = null

function transport(): Promise<ChannelLocatorTransport> {
  if (!transportP) transportP = buildTransport()
  return transportP
}

async function buildTransport(): Promise<ChannelLocatorTransport> {
  if (inTauri()) {
    // Dynamically imported so its `@tauri-apps/api` import never enters the web bundle
    // (same pattern as connectSiaClient / pkarrTransport / docs).
    const { makeTauriChannelLocator } = await import('./tauriChannelLocator')
    return makeTauriChannelLocator()
  }
  return {
    publishLocator: async (channelKey, manifestJson) => {
      await ensureWasm()
      return JSON.parse(
        await channel_publish(channelKey, manifestJson),
      ) as PublishedLocator
    },
    resolveLocator: async (channelKey) => {
      await ensureWasm()
      const json = await channel_resolve(channelKey)
      return json === undefined ? null : (JSON.parse(json) as ResolvedLocator)
    },
    republishPointer: async (channelKey, itemURL) => {
      await ensureWasm()
      return channel_republish_pointer(channelKey, itemURL)
    },
    resolveTalliesUrl: async (channelKey) => {
      await ensureWasm()
      return (await channel_resolve_tallies_url(channelKey)) ?? null
    },
    fetchTallies: async (channelKey, itemURL) => {
      await ensureWasm()
      return channel_fetch_tallies(channelKey, itemURL)
    },
  }
}

/** Seal a manifest under K, upload it, and sign the pointer. */
export async function publishLocator(
  channelKey: Uint8Array,
  manifestJson: string,
): Promise<PublishedLocator> {
  return (await transport()).publishLocator(channelKey, manifestJson)
}

/** Read a channel from K alone. Null when the locator resolves to nothing — the channel
 *  may never have been published, or its record may have aged off the DHT. */
export async function resolveLocator(
  channelKey: Uint8Array,
): Promise<ResolvedLocator | null> {
  return (await transport()).resolveLocator(channelKey)
}

/** Re-sign a channel's current pointer to refresh its TTL, minting no new object. */
export async function republishPointer(
  channelKey: Uint8Array,
  itemURL: string,
): Promise<void> {
  return (await transport()).republishPointer(channelKey, itemURL)
}

/** Where a channel's tallies currently are, or null when none are published — which is
 *  ordinary and common, since a channel nobody has endorsed has no tallies object.
 *
 *  Split from the fetch because the URL is a content address: a caller holding the one it
 *  last read knows from this alone that the counts are unchanged, and skips the download. */
export async function resolveTalliesUrl(
  channelKey: Uint8Array,
): Promise<string | null> {
  return (await transport()).resolveTalliesUrl(channelKey)
}

/** Download and open a channel's tallies at a URL already resolved for it, returning the
 *  subject-to-tally map as JSON. */
export async function fetchTallies(
  channelKey: Uint8Array,
  itemURL: string,
): Promise<string> {
  return (await transport()).fetchTallies(channelKey, itemURL)
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
