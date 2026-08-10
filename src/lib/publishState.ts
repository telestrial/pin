// What this identity has published to Sia, and which object each pointer names.
//
// Sia is content-addressed, so every republish mints a NEW object and supersedes the
// last one. Reclaiming the superseded object needs a record of what it was — that's
// this. The orphan sweep was removed in 06-18 on the positive-id principle (only
// delete ids you explicitly tried to delete), which makes this record the ONLY thing
// standing between a supersede and a permanent leak.
//
// It used to live in localStorage, which quietly made it device-local: a second device
// publishing to the same channel found no pointer, so it skipped both the grace delete
// and the reclaim, and the objects the first device had been tracking leaked with
// nothing left to sweep them. Publish state isn't a cache — it's the record of what you
// did, and it has to travel with you. So it lives in the doc, which syncs.
//
// Encrypted under its own AppKey-derived key: these records carry Sia share URLs, and a
// share URL's fragment IS that object's decryption key.

import {
  published_channel_rkey,
  published_collection,
  published_settings_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
import {
  decryptForChannel,
  derivePublishedKey,
  encryptForChannel,
} from '../core/crypto'
import { ensureWasm } from '../core/wasm'
import { deleteRecord, getRecord, openDocs, putRecord } from './docs'

/** One publisher's current Sia object, plus the generation it just superseded.
 *  `olderId` is kept ALIVE deliberately where a grace window is wanted (see
 *  `commitChannelManifest`) and is the reclaim target one publish later. */
export type PublishedObject = {
  id: string
  url?: string
  olderId?: string
}

/** The rkey for one channel's publish state.
 *
 *  From Rust, because the Curator's keep-alive loop reads these records: a divergence
 *  wouldn't error, it would just find nothing, and a locator nobody republishes ages
 *  off the DHT until the channel stops resolving for its subscribers. */
export async function channelPublishKey(channelID: string): Promise<string> {
  await ensureWasm()
  return published_channel_rkey(channelID)
}

/** The rkey for the settings snapshot's publish state. From Rust for the same reason:
 *  the Curator's keep-alive republishes the settings locator from this record, and it
 *  is the pointer a device holding only the recovery phrase follows to find the
 *  account. */
export async function settingsPublishKey(): Promise<string> {
  await ensureWasm()
  return published_settings_rkey()
}

export async function collection(): Promise<string> {
  await ensureWasm()
  return published_collection()
}

async function key(appKeyHex: string): Promise<Uint8Array> {
  return derivePublishedKey(Uint8Array.fromHex(appKeyHex))
}

/** What we last published under this rkey, or null when we don't know.
 *
 *  Tolerant on purpose: not knowing is a state a caller can handle (skip the reclaim,
 *  skip the keep-alive), whereas throwing would fail a publish over bookkeeping. */
export async function readPublished(
  appKeyHex: string,
  rkey: string,
): Promise<PublishedObject | null> {
  try {
    await openDocs(appKeyHex)
    const sealed = await getRecord(await collection(), rkey)
    if (!sealed) return null
    const json = await decryptForChannel(
      await key(appKeyHex),
      new TextDecoder().decode(sealed),
    )
    return JSON.parse(json) as PublishedObject
  } catch {
    return null
  }
}

/** Record what we just published. Best-effort — the manifest is already live by the
 *  time this runs, so failing the publish over its bookkeeping would be the worse
 *  error — but noisy, because a lost write means an object nothing will ever reclaim. */
export async function writePublished(
  appKeyHex: string,
  rkey: string,
  value: PublishedObject,
): Promise<void> {
  try {
    await openDocs(appKeyHex)
    const sealed = await encryptForChannel(
      await key(appKeyHex),
      JSON.stringify(value),
    )
    await putRecord(await collection(), rkey, new TextEncoder().encode(sealed))
  } catch (e) {
    console.warn(`publish state write failed for ${rkey}:`, e)
  }
}

/** Forget what we published under this rkey — for when the thing itself is gone
 *  (a retracted channel), so the record doesn't outlive its subject. */
export async function clearPublished(
  appKeyHex: string,
  rkey: string,
): Promise<void> {
  try {
    await openDocs(appKeyHex)
    await deleteRecord(await collection(), rkey)
  } catch {
    // A stray record is small and opaque; the next publish overwrites it anyway.
  }
}
