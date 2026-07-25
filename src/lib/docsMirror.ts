// Option B web durability: snapshot the (ephemeral) browser iroh-docs doc to Sia
// and re-hydrate it on load. The browser has no persistent iroh-docs store
// (MemStore only), so the doc's contents are mirrored to Sia (durable) and put
// back into a fresh doc when the app boots. All in TS over the Sia SDK the app
// already has — no Rust Curator / did:dht needed (that's Phase D).
//
// Pointer: "which Sia object is the latest snapshot" is cached in localStorage
// (the data lives on Sia; the pointer is cache). A cold/wiped device has no
// pointer, so hydrate is a no-op today — the objectEvents cold-recovery walk
// (find the newest pin:docsnapshot-tagged object) is a deferred follow-up.

import {
  decryptForChannel,
  deriveSettingsLocatorSeed,
  deriveSnapshotKey,
  encryptForChannel,
} from '../core/crypto'
import type { SiaClient } from '../core/siaClient'
import { getRecord, listAll, putRecord } from './docs'
import { chunkForTxt, identityFromSeed, reassembleTxt } from './pkarr'
import { pkarrTransport } from './pkarrTransport'

const POINTER_KEY = 'pin:docsnapshot:pointer'
// TXT prefix for the chunked Sia-snapshot URL in the settings-locator document.
const SETTINGS_POINTER_PREFIX = '_s'

// collection, rkey, value(base64). Short keys keep the snapshot JSON compact.
type SnapshotEntry = { c: string; k: string; v: string }
type Pointer = { id: string; url: string }

function readPointer(): Pointer | null {
  try {
    const s = localStorage.getItem(POINTER_KEY)
    return s ? (JSON.parse(s) as Pointer) : null
  } catch {
    return null
  }
}

function writePointer(p: Pointer): void {
  try {
    localStorage.setItem(POINTER_KEY, JSON.stringify(p))
  } catch {
    // localStorage unavailable / quota — the pointer is a cache, safe to skip.
  }
}

function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function b64decode(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// Publish the durable settings pointer: a pkarr record (AppKey-keyed) naming the
// current Sia snapshot URL. This is what lets a fresh device recover settings from
// the recovery phrase alone (phrase → AppKey → locator key → DHT → Sia URL) — the
// localStorage pointer is only a fast cache in front of it. Routed through the
// pkarrTransport seam, so desktop publishes over the direct Mainline DHT (no relay
// lag) and web over the relays, same as channel locators.
async function publishSettingsLocator(
  appKeyBytes: Uint8Array,
  url: string,
): Promise<void> {
  const seed = await deriveSettingsLocatorSeed(appKeyBytes)
  await (await pkarrTransport()).publish(
    seed,
    chunkForTxt(SETTINGS_POINTER_PREFIX, url),
  )
}

// Resolve the durable settings pointer off the DHT → the current Sia snapshot URL.
// null when nothing's published / resolvable. The recovery read path for a device
// with no localStorage pointer (a restore, or a wiped-pointer catastrophe boot).
async function resolveSettingsPointer(
  appKeyBytes: Uint8Array,
): Promise<string | null> {
  const seed = await deriveSettingsLocatorSeed(appKeyBytes)
  const { publicKey } = await identityFromSeed(seed)
  const records = await (await pkarrTransport()).resolve(publicKey)
  return reassembleTxt(records, SETTINGS_POINTER_PREFIX) || null
}

/** Snapshot the whole doc to Sia (encrypted), update the pointer, publish the
 *  durable pkarr locator, prune the previous snapshot. Call (debounced) after
 *  writes. */
export async function snapshotToSia(
  client: SiaClient,
  appKeyBytes: Uint8Array,
): Promise<Pointer> {
  const key = await deriveSnapshotKey(appKeyBytes)
  const entries: SnapshotEntry[] = []
  for (const { collection, rkey } of await listAll()) {
    const value = await getRecord(collection, rkey)
    if (value) entries.push({ c: collection, k: rkey, v: b64encode(value) })
  }
  const ciphertext = await encryptForChannel(key, JSON.stringify(entries))
  const uploaded = await client.uploadItem(new TextEncoder().encode(ciphertext))

  const prev = readPointer()
  writePointer({ id: uploaded.id, url: uploaded.itemURL })

  // Publish the durable DHT pointer (best-effort — the localStorage pointer above
  // already made this snapshot readable on THIS device; a failed publish just
  // retries on the next snapshot, and the previous locator still resolves).
  await publishSettingsLocator(appKeyBytes, uploaded.itemURL).catch((e) =>
    console.warn('settings locator publish failed (will retry):', e),
  )

  // Best-effort prune of the superseded snapshot object (the new one is already
  // pointed at, so a failed prune only leaves a reclaimable orphan). Guard on a
  // non-empty id: a pointer recovered from the DHT locator carries only the URL
  // (id ''), which can't be pruned — that object is left for the sweep.
  if (prev?.id && prev.id !== uploaded.id) {
    await client
      .deleteObject(prev.id)
      .then(() => client.pruneSlabs())
      .catch(() => {})
  }
  return { id: uploaded.id, url: uploaded.itemURL }
}

// Download + decrypt the latest Sia snapshot into its entries — WITHOUT the
// pin-core engine. The snapshot is a self-contained durable copy, so a plain Sia
// download + decrypt is enough. localStorage pointer first (fast, warm device);
// when it's absent AND recovery is allowed (a restore / wiped-pointer boot, never a
// brand-new account), fall back to resolving the durable DHT locator, and cache the
// recovered URL so subsequent reads this session skip the resolve. [] when there's
// no pointer and recovery is off or finds nothing.
async function fetchSnapshotEntries(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  recoverViaLocator = false,
): Promise<SnapshotEntry[]> {
  let url = readPointer()?.url ?? null
  if (!url && recoverViaLocator) {
    url = await resolveSettingsPointer(appKeyBytes)
    // Cache the recovered URL (id unknown — only the URL lives on the DHT; the
    // next full snapshot supersedes it with a prunable pointer).
    if (url) writePointer({ id: '', url })
  }
  if (!url) return []
  const key = await deriveSnapshotKey(appKeyBytes)
  const bytes = await client.downloadItem(url)
  const ciphertext = new TextDecoder().decode(bytes)
  return JSON.parse(await decryptForChannel(key, ciphertext)) as SnapshotEntry[]
}

/** Re-hydrate the fresh doc from the latest Sia snapshot (into pin-core). Call
 *  after openDocs, before any reads. Returns how many records were restored. */
export async function hydrateFromSia(
  client: SiaClient,
  appKeyBytes: Uint8Array,
): Promise<number> {
  const entries = await fetchSnapshotEntries(client, appKeyBytes)
  for (const e of entries) {
    await putRecord(e.c, e.k, b64decode(e.v))
  }
  return entries.length
}

/** Read one record's bytes straight from the latest Sia snapshot, WITHOUT the
 *  pin-core engine (no wasm, no relay). The boot read path: settings / channels
 *  can be sourced from the durable snapshot cheaply. Pass `recoverViaLocator` to
 *  fall back to the durable DHT locator when there's no local pointer (a restore /
 *  wiped-pointer boot — never a brand-new account). undefined if there's no
 *  snapshot or the record isn't in it. */
export async function readRecordFromSnapshot(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  collection: string,
  rkey: string,
  recoverViaLocator = false,
): Promise<Uint8Array | undefined> {
  const entries = await fetchSnapshotEntries(
    client,
    appKeyBytes,
    recoverViaLocator,
  )
  const hit = entries.find((e) => e.c === collection && e.k === rkey)
  return hit ? b64decode(hit.v) : undefined
}
