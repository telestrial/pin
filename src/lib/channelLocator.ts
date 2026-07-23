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

import type { Sdk } from '@siafoundation/sia-storage'
import {
  channelKeyFromBase64,
  decryptForChannel,
  deriveChannelLocatorSeed,
  encryptForChannel,
} from '../core/crypto'
import type { FetchChannel } from '../core/feed'
import { downloadItem, uploadItem } from '../core/sia'
import { CHANNEL_MANIFEST_VERSION, type ChannelManifest } from '../core/types'
import {
  chunkForTxt,
  identityFromSeed,
  publishRecords,
  reassembleTxt,
  resolveDidDht,
} from './pkarr'

// TXT record name prefix for the chunked Sia pointer in a channel-locator document.
const POINTER_PREFIX = '_c'

// localStorage key prefix for the manifest-object generations behind a channel's
// locator, one entry per owned channel. `id` = the current object the pkarr
// pointer names; `olderId` = the immediately-previous generation, kept ALIVE as
// a grace window. localStorage is a cache: losing it only risks a couple of
// stray small manifest objects, never data.
const OBJECT_POINTER_PREFIX = 'pin:chanloc:'
type LocatorObjectPointer = { id: string; url?: string; olderId?: string }

export function readLocatorObjectPointer(
  channelID: string,
): LocatorObjectPointer | null {
  try {
    const s = localStorage.getItem(OBJECT_POINTER_PREFIX + channelID)
    return s ? (JSON.parse(s) as LocatorObjectPointer) : null
  } catch {
    return null
  }
}
function writeLocatorObjectPointer(
  channelID: string,
  pointer: LocatorObjectPointer,
): void {
  try {
    localStorage.setItem(
      OBJECT_POINTER_PREFIX + channelID,
      JSON.stringify(pointer),
    )
  } catch {
    // localStorage unavailable/quota — the pointer is a cache, safe to skip.
  }
}
export function clearLocatorObjectPointer(channelID: string): void {
  try {
    localStorage.removeItem(OBJECT_POINTER_PREFIX + channelID)
  } catch {}
}

/** Mirror a channel's manifest to its own Sia object (encrypted under K) and publish
 *  the pointer to that object under the channel's K-derived pkarr locator. Call
 *  (background) whenever the manifest changes. ~5s (Mainline store latency).
 *
 *  Returns the locator key + the Sia object's id/URL. The caller (the publish hook)
 *  deletes the superseded object using the returned id. */
export async function publishChannelLocator(
  sdk: Sdk,
  channelKeyB64: string,
  manifest: ChannelManifest,
): Promise<{ locatorKey: string; id: string; url: string }> {
  const kBytes = channelKeyFromBase64(channelKeyB64)
  const ciphertext = await encryptForChannel(kBytes, JSON.stringify(manifest))
  const uploaded = await uploadItem(sdk, new TextEncoder().encode(ciphertext))

  const { keypair, publicKey } = await identityFromSeed(
    await deriveChannelLocatorSeed(kBytes),
  )
  await publishRecords(keypair, chunkForTxt(POINTER_PREFIX, uploaded.itemURL))
  return { locatorKey: publicKey, id: uploaded.id, url: uploaded.itemURL }
}

/** Reader side: resolve a channel from its K alone (no atproto, no author handle).
 *  Derive the locator → resolve the Sia pointer off the DHT → download + decrypt
 *  with K. Returns null when the locator isn't published / resolvable. */
export async function resolveChannelViaLocator(
  sdk: Sdk,
  channelKeyB64: string,
): Promise<ChannelManifest | null> {
  const kBytes = channelKeyFromBase64(channelKeyB64)
  const { publicKey } = await identityFromSeed(
    await deriveChannelLocatorSeed(kBytes),
  )
  const records = await resolveDidDht(publicKey)
  const url = reassembleTxt(records, POINTER_PREFIX)
  if (!url) return null

  const bytes = await downloadItem(sdk, url)
  const plaintext = await decryptForChannel(
    kBytes,
    new TextDecoder().decode(bytes),
  )
  const manifest = JSON.parse(plaintext)
  if (manifest?.version !== CHANNEL_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported channel manifest version (got ${manifest?.version}, expected ${CHANNEL_MANIFEST_VERSION})`,
    )
  }
  return manifest as ChannelManifest
}

/** A `FetchChannel` that reads a channel purely from its pkarr locator (no
 *  atproto). Channels are locator-native now, so a miss/error is a genuine
 *  read failure — it throws, and `buildHomeFeed` records it as a channel error
 *  (rather than silently masking a DHT/Sia problem behind an atproto read that
 *  no longer has anything to serve). The sdk is closed over; the `FetchChannel`
 *  signature keeps its author-identifier arg (unused here) so this drops in
 *  wherever the feed's fetcher is injected. */
export function makeLocatorReader(sdk: Sdk): FetchChannel {
  return async (_authorHandleOrDID, channelID, channelKey) => {
    const manifest = await resolveChannelViaLocator(sdk, channelKey)
    if (!manifest) {
      throw new Error(`Channel ${channelID} not resolvable (no locator)`)
    }
    return manifest
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
  sdk: Sdk,
  channelID: string,
  channelKeyB64: string,
  manifest: ChannelManifest,
): Promise<void> {
  const prev = readLocatorObjectPointer(channelID)
  const { id, url } = await publishChannelLocator(sdk, channelKeyB64, manifest)
  // New current = id; keep prev.id as the grace generation; reclaim prev.olderId.
  writeLocatorObjectPointer(channelID, {
    id,
    url,
    olderId: prev && prev.id !== id ? prev.id : prev?.olderId,
  })
  const toReclaim = prev?.olderId
  if (toReclaim && toReclaim !== id && toReclaim !== prev?.id) {
    await sdk
      .deleteObject(toReclaim)
      .then(() => sdk.pruneSlabs())
      .catch(() => {})
  }
}

/** Keep-alive: refresh a channel locator's pkarr TTL WITHOUT minting a new Sia
 *  object, so a channel published in an earlier session stays resolvable as the
 *  record ages off the DHT. Re-signs/re-publishes the author's OWN current
 *  pointer — read from the LOCAL locator record, NOT a fresh DHT resolve. A
 *  resolve here could read back a stale value from a lagging relay and then
 *  re-sign it with a newer timestamp, burying the real current pointer; the
 *  author already knows their current pointer locally, so use that. No-op if
 *  nothing's published for this channel yet (a commit establishes it). */
export async function refreshChannelLocator(
  channelKeyB64: string,
  channelID: string,
): Promise<void> {
  const pointer = readLocatorObjectPointer(channelID)
  if (!pointer?.url) return
  const kBytes = channelKeyFromBase64(channelKeyB64)
  const { keypair } = await identityFromSeed(
    await deriveChannelLocatorSeed(kBytes),
  )
  await publishRecords(keypair, chunkForTxt(POINTER_PREFIX, pointer.url))
}
