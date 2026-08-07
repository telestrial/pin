// Phase D per-channel read surface: how a reader finds + reads one channel's
// content without atproto. Each channel is mirrored to its OWN Sia object (manifest
// encrypted under K) and located by a per-channel pkarr record whose key derives
// from K. A reader holding K (from the subscribe URL) derives the same locator,
// resolves the Sia pointer off the DHT, downloads the object, and decrypts with K.
// K both LOCATES and DECRYPTS — the same capability shape as a Sia share URL.
//
// This is the cross-user replacement for `fetchChannel`'s atproto getRecord. It is
// per-channel (not whole-doc) on purpose: iroh-docs' capability grain is the
// namespace and Pin's is per-channel K, so obscure channels stay unenumerable — you
// can't derive a channel's locator without its K.

import { channelKeyFromBase64 } from '../core/crypto'
import type { FetchChannel } from '../core/feed'
import type { SiaClient } from '../core/siaClient'
import { CHANNEL_MANIFEST_VERSION, type ChannelManifest } from '../core/types'
import {
  openBlob,
  publishLocator,
  republishPointer,
  resolveLocator,
} from './channelLocatorNative'
import { getRecord, openDocs, putRecord } from './docs'
import {
  channelPublishKey,
  readPublished,
  writePublished,
} from './publishState'

// Collection in the shared iroh-docs doc where resolved subscribed-channel
// manifests are cached (the resolution-ladder "keep" step). Value = the EXACT Sia
// ciphertext (opaque bytes under the subscribed channel's K), so a reader decrypts
// it identically to a fresh resolve — no second code path, and whatever writes it
// stays content-blind. Keyed by channelID.
const SUB_COLLECTION = 'sub'

/** Mirror a channel's manifest to its own Sia object (encrypted under K) and publish
 *  the pointer to that object under the channel's K-derived pkarr locator. Call
 *  (background) whenever the manifest changes. ~5s (Mainline store latency).
 *
 *  Returns the locator key + the Sia object's id/URL. The caller (the publish hook)
 *  deletes the superseded object using the returned id. */
export async function publishChannelLocator(
  channelKeyB64: string,
  manifest: ChannelManifest,
): Promise<{ locatorKey: string; id: string; url: string }> {
  const published = await publishLocator(
    channelKeyFromBase64(channelKeyB64),
    JSON.stringify(manifest),
  )
  return {
    locatorKey: published.locatorKey,
    id: published.objectId,
    url: published.itemURL,
  }
}

/** Decrypt + parse a channel-manifest ciphertext blob with K, checking the version.
 *  The blob is exactly what the Sia object holds (and what `sub/<id>` caches), so
 *  the fresh-resolve and cached-read paths decode identically. */
export async function decodeChannelManifest(
  kBytes: Uint8Array,
  ciphertext: Uint8Array,
): Promise<ChannelManifest> {
  const manifest = JSON.parse(
    await openBlob(kBytes, new TextDecoder().decode(ciphertext)),
  )
  if (manifest?.version !== CHANNEL_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported channel manifest version (got ${manifest?.version}, expected ${CHANNEL_MANIFEST_VERSION})`,
    )
  }
  return manifest as ChannelManifest
}

/** Resolve a channel from its K, returning BOTH the parsed manifest and the raw
 *  ciphertext bytes (so a caller can cache the exact blob). Null when the locator
 *  isn't published / resolvable. */
async function resolveChannelBytes(
  channelKeyB64: string,
): Promise<{ manifest: ChannelManifest; ciphertext: Uint8Array } | null> {
  const resolved = await resolveLocator(channelKeyFromBase64(channelKeyB64))
  if (!resolved) return null

  const manifest = JSON.parse(resolved.manifestJson)
  if (manifest?.version !== CHANNEL_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported channel manifest version (got ${manifest?.version}, expected ${CHANNEL_MANIFEST_VERSION})`,
    )
  }
  return {
    manifest: manifest as ChannelManifest,
    // The blob as the doc cache stores it — byte-identical to what came off Sia, since
    // it is ASCII base64.
    ciphertext: new TextEncoder().encode(resolved.blob),
  }
}

/** Reader side: resolve a channel from its K alone (no atproto, no author handle).
 *  Derive the locator → resolve the Sia pointer off the DHT → download + decrypt
 *  with K. Returns null when the locator isn't published / resolvable. */
export async function resolveChannelViaLocator(
  channelKeyB64: string,
): Promise<ChannelManifest | null> {
  const resolved = await resolveChannelBytes(channelKeyB64)
  return resolved ? resolved.manifest : null
}

/** Cache a resolved subscribed-channel manifest into the shared iroh-docs doc, so
 *  other instances/tabs (and later reads) land higher on the resolution ladder.
 *  Best-effort — the cache is an optimization, never load-bearing; a failed write
 *  just gets re-seeded by the next resolve. `openDocs` is memoized, so calling it
 *  per cache is cheap. */
async function cacheSubscribedManifest(
  appKeyHex: string,
  channelID: string,
  ciphertext: Uint8Array,
): Promise<void> {
  try {
    await openDocs(appKeyHex)
    await putRecord(SUB_COLLECTION, channelID, ciphertext)
  } catch {
    // Doc unavailable / write failed — a re-resolve re-caches next time.
  }
}

/** A `FetchChannel` that reads a channel purely from its pkarr locator (no
 *  atproto). Channels are locator-native now, so a miss/error is a genuine
 *  read failure — it throws, and `buildHomeFeed` records it as a channel error
 *  (rather than silently masking a DHT/Sia problem behind an atproto read that
 *  no longer has anything to serve). The `FetchChannel` signature keeps its
 *  author-identifier arg (unused here) so this drops in wherever the feed's fetcher
 *  is injected. */
export function makeLocatorReader(): FetchChannel {
  return async (_authorHandleOrDID, channelID, channelKey) => {
    const manifest = await resolveChannelViaLocator(channelKey)
    if (!manifest) {
      throw new Error(`Channel ${channelID} not resolvable (no locator)`)
    }
    return manifest
  }
}

/** Read a subscribed channel's manifest from the shared-doc cache (`sub/<id>`),
 *  decrypting the cached ciphertext with K. Null when there's no cached record
 *  (or it won't decode — fall through to a fresh resolve). */
async function readCachedManifest(
  appKeyHex: string,
  channelID: string,
  channelKey: string,
): Promise<ChannelManifest | null> {
  try {
    await openDocs(appKeyHex)
    const cached = await getRecord(SUB_COLLECTION, channelID)
    if (!cached) return null
    return await decodeChannelManifest(channelKeyFromBase64(channelKey), cached)
  } catch {
    return null
  }
}

/** The feed-path reader (resolution-ladder, all three rungs). For a SUBSCRIBED
 *  (not-owned) channel it prefers the shared-doc cache (`sub/<channelID>`) — fast,
 *  no network — falling through to a fresh locator resolve (+ cache-back) on a
 *  miss. The eager pull loop (useSubscriptionPull) keeps that cache fresh, so the
 *  cached read isn't stuck-stale; a cold-open tab whose loop hasn't run yet just
 *  takes the fresh-resolve path (today's behavior) and seeds the cache.
 *
 *  OWNED channels skip the cache and always resolve fresh: their freshest state is
 *  local (reflected on publish), and buildHomeFeed uses a successful read verbatim,
 *  so serving a stale cache for an own channel would clobber a just-published post.
 *
 *  `fresh` (an explicit user Refresh) also skips the cache. Without that, Refresh —
 *  the only control a reader has — could never be newer than the last background
 *  pass, which is a worse deal than the always-resolve reads the cache replaced.
 *  It still caches the result, so the fast path stays warm.
 *
 *  Falls back to a plain resolve (via `makeLocatorReader`) when there's no
 *  appKeyHex to open the doc with. */
export function makeCachingLocatorReader(
  appKeyHex: string,
  ownedChannelIDs: ReadonlySet<string>,
): FetchChannel {
  return async (_authorHandleOrDID, channelID, channelKey, fresh) => {
    if (!fresh && !ownedChannelIDs.has(channelID)) {
      const cached = await readCachedManifest(appKeyHex, channelID, channelKey)
      if (cached) return cached
    }
    const resolved = await resolveChannelBytes(channelKey)
    if (!resolved) {
      throw new Error(`Channel ${channelID} not resolvable (no locator)`)
    }
    if (!ownedChannelIDs.has(channelID)) {
      void cacheSubscribedManifest(appKeyHex, channelID, resolved.ciphertext)
    }
    return resolved.manifest
  }
}

/** Commit a channel's manifest as its canonical published state: upload the new
 *  Sia object under K + publish the K-derived pkarr locator, then reclaim an
 *  OLD generation. Awaited — when it resolves, the Sia object and the DHT
 *  pointer are both live (the "done" bar for a channel write).
 *
 *  Grace deletion (keep-2): a pkarr publish takes seconds to propagate on the
 *  Mainline DHT, so right after a commit a reader can still resolve the PREVIOUS
 *  pointer. If we deleted the previous object immediately, that reader would hit
 *  "object not found". So we keep the current + the immediately-previous
 *  generation alive, and only reclaim the one TWO commits back (which no
 *  up-to-date-within-one-commit reader can still be pointed at). Bounded to two
 *  live manifest objects per channel. */
export async function commitChannelManifest(
  client: SiaClient,
  appKeyHex: string,
  channelID: string,
  channelKeyB64: string,
  manifest: ChannelManifest,
): Promise<void> {
  const rkey = await channelPublishKey(channelID)
  const prev = await readPublished(appKeyHex, rkey)
  const { id, url } = await publishChannelLocator(channelKeyB64, manifest)
  // New current = id; keep prev.id as the grace generation; reclaim prev.olderId.
  await writePublished(appKeyHex, rkey, {
    id,
    url,
    olderId: prev && prev.id !== id ? prev.id : prev?.olderId,
  })
  const toReclaim = prev?.olderId
  if (toReclaim && toReclaim !== id && toReclaim !== prev?.id) {
    await client
      .deleteObject(toReclaim)
      .then(() => client.pruneSlabs())
      .catch(() => {})
  }
}

/** Keep-alive: refresh a channel locator's pkarr TTL WITHOUT minting a new Sia
 *  object, so a channel published in an earlier session stays resolvable as the
 *  record ages off the DHT. Re-signs/re-publishes the author's OWN current
 *  pointer — read from the publish-state record, NOT a fresh DHT resolve. A
 *  resolve here could read back a stale value from a lagging relay and then
 *  re-sign it with a newer timestamp, burying the real current pointer; the
 *  author already knows their current pointer, so use that. No-op if nothing's
 *  published for this channel yet (a commit establishes it). */
export async function refreshChannelLocator(
  appKeyHex: string,
  channelKeyB64: string,
  channelID: string,
): Promise<void> {
  const published = await readPublished(
    appKeyHex,
    await channelPublishKey(channelID),
  )
  if (!published?.url) return
  await republishPointer(channelKeyFromBase64(channelKeyB64), published.url)
}
