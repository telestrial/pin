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

/** Mirror a channel's manifest to its own Sia object (encrypted under K) and publish
 *  the pointer to that object under the channel's K-derived pkarr locator. Call
 *  (background) whenever the manifest changes. ~5s (Mainline store latency).
 *
 *  Returns the locator key + Sia URL. Old-object cleanup (delete the superseded Sia
 *  object) is deferred to the live-edit wiring (step 4), same as docsMirror. */
export async function publishChannelLocator(
  sdk: Sdk,
  channelKeyB64: string,
  manifest: ChannelManifest,
): Promise<{ locatorKey: string; url: string }> {
  const kBytes = channelKeyFromBase64(channelKeyB64)
  const ciphertext = await encryptForChannel(kBytes, JSON.stringify(manifest))
  const uploaded = await uploadItem(sdk, new TextEncoder().encode(ciphertext))

  const { keypair, publicKey } = await identityFromSeed(
    await deriveChannelLocatorSeed(kBytes),
  )
  await publishRecords(keypair, chunkForTxt(POINTER_PREFIX, uploaded.itemURL))
  return { locatorKey: publicKey, url: uploaded.itemURL }
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
