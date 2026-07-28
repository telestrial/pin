// The doc-engine binding — the app's one interface to iroh-docs, the atproto repo's
// replacement. Records are keyed by (collection, rkey), values are opaque bytes (the
// same encrypted blob the app writes today).
//
// One surface, two transports, picked by inTauri():
//   - Web: the wasm pin-core module, running in-page (ephemeral MemStore).
//   - Desktop: Tauri IPC to the native Curator's PERSISTENT replica (tauriDocs.ts) —
//     the same replica the Curator serves over iroh. So on desktop the app's writes
//     land in the Curator's repo, not a throwaway in-webview copy. The Curator
//     auto-starts once connected (useCuratorAutostart), so its doc is up by the time
//     a consumer opens.
// The Tauri path's IPC module is dynamically imported (inside tauriDocs), so it never
// enters the web bundle; and the 7 MB wasm only instantiates when the web path runs.

import initWasm, {
  open as coreOpen,
  share as coreShare,
  start_sync as coreStartSync,
  status as coreStatus,
  delete_record,
  get_record,
  list_all,
  list_records,
  put_record,
} from '../../crates/pin-core/pkg/pin_core.js'
import { useCuratorStore } from '../stores/curator'
import { inTauri } from './openExternal'
import {
  deleteRecordNative,
  getRecordNative,
  listAllNative,
  listRecordsNative,
  openDocsNative,
  putRecordNative,
  shareDocNative,
  startSyncNative,
} from './tauriDocs'

let wasmReady: Promise<void> | null = null
function ensureReady(): Promise<void> {
  if (!wasmReady) wasmReady = initWasm().then(() => undefined)
  return wasmReady
}

// Open the engine exactly ONCE per identity and share it across every caller.
// pin-core's `open` REBUILDS the engine from scratch on each call (fresh endpoint,
// fresh MemStore) — so a second open would drop an active start_sync subscription
// AND wipe other hooks' in-memory writes. Memoizing (keyed on the AppKey hex) makes
// every doc hook + the sync loop talk to one stable engine. A key change (sign
// out/in a different identity) re-opens for the new identity; a failed open clears
// the cache so a later call retries.
let openState: { key: string; promise: Promise<string> } | null = null

/** Open/create the doc for this identity (namespace + author derived from the Sia
 *  AppKey). Returns the namespace id. On desktop this waits for the auto-started
 *  Curator's doc; on web it opens the in-page wasm engine. Idempotent per identity —
 *  the underlying engine is opened once and reused. */
export async function openDocs(appKeyHex: string): Promise<string> {
  if (openState && openState.key === appKeyHex) return openState.promise
  const promise = (async () => {
    if (inTauri()) return openDocsNative()
    await ensureReady()
    return coreOpen(appKeyHex)
  })()
  openState = { key: appKeyHex, promise }
  // Record the open here rather than in a caller: openDocs is memoized, so this is
  // the one place that runs exactly once per identity no matter which hook got
  // there first. Feeds the web instance's uptime + namespace on the Curate page.
  promise.then(
    (namespace) =>
      useCuratorStore.getState().set({ namespace, openedAt: Date.now() }),
    (e: unknown) => useCuratorStore.getState().set({ lastError: String(e) }),
  )
  // On failure, drop the cache so the next call can re-attempt the open.
  promise.catch(() => {
    if (openState?.promise === promise) openState = null
  })
  return promise
}

export async function putRecord(
  collection: string,
  rkey: string,
  value: Uint8Array,
): Promise<void> {
  if (inTauri()) return putRecordNative(collection, rkey, value)
  await ensureReady()
  await put_record(collection, rkey, value)
}

export async function getRecord(
  collection: string,
  rkey: string,
): Promise<Uint8Array | undefined> {
  if (inTauri()) return getRecordNative(collection, rkey)
  await ensureReady()
  return get_record(collection, rkey) ?? undefined
}

export async function deleteRecord(
  collection: string,
  rkey: string,
): Promise<void> {
  if (inTauri()) return deleteRecordNative(collection, rkey)
  await ensureReady()
  await delete_record(collection, rkey)
}

export async function listRecords(collection: string): Promise<string[]> {
  if (inTauri()) return listRecordsNative(collection)
  await ensureReady()
  return (await list_records(collection)) as string[]
}

/** Every record across all collections, as {collection, rkey} pairs. Used to
 *  snapshot the whole doc (docsMirror). */
export async function listAll(): Promise<
  Array<{ collection: string; rkey: string }>
> {
  if (inTauri()) return listAllNative()
  await ensureReady()
  const keys = (await list_all()) as string[]
  return keys.map((key) => {
    const i = key.indexOf('/')
    return { collection: key.slice(0, i), rkey: key.slice(i + 1) }
  })
}

/** Produce a shareable DocTicket for this identity's doc (write cap + relay addr).
 *  A peer imports it via {@link startSync} to live-sync. On desktop this is the
 *  Curator's own ticket; on web the in-page wasm engine's. Requires an open doc
 *  ({@link openDocs}). */
export async function shareDoc(): Promise<string> {
  if (inTauri()) return shareDocNative()
  await ensureReady()
  return coreShare()
}

/** Join the peer(s) in `ticket` and live-sync this identity's doc with them.
 *  `onEvent` fires with a short label per sync event (insert-local / insert-remote /
 *  sync-finished / neighbor-up|down). The doc must already be open ({@link openDocs}).
 *
 *  Symmetric across platforms: web drives the wasm engine; desktop drives the native
 *  Curator's engine via `curator_start_sync`. One import reconciles both directions,
 *  so this is what lets a desktop actively pull from a peer too — not just be
 *  synced-from. (Desktop sync events aren't surfaced over IPC, so onEvent stays quiet
 *  there; reconciliation doesn't need a subscriber.) */
export async function startSync(
  ticket: string,
  onEvent: (label: string) => void,
): Promise<void> {
  if (inTauri()) return startSyncNative(ticket)
  await ensureReady()
  await coreStartSync(ticket, onEvent)
}

/** This instance's iroh network status (node id, relay/direct addresses), from the
 *  in-page wasm engine. Web-only by design: on desktop the doc engine IS the native
 *  Curator's, so its network status arrives on the Curator's own IPC status instead
 *  of here — see `curatorStatus`, which is the seam that unifies the two into one
 *  shape. Null when the engine isn't open yet (or on desktop). */
export async function docsStatus(): Promise<DocsNetworkStatus | null> {
  if (inTauri()) return null
  await ensureReady()
  try {
    return coreStatus() as DocsNetworkStatus
  } catch {
    // Engine not open yet — no status to report.
    return null
  }
}

export type DocsNetworkStatus = {
  nodeId: string
  online: boolean
  relays: string[]
  directAddrs: string[]
  otherAddrs: string[]
}

/** Dev-only roundtrip through the active transport (wasm on web, native Curator on
 *  desktop): open + put + get + list + delete. Exposed on window in main.tsx (dev). */
export async function docsSelfTest(appKeyHex: string): Promise<string> {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const namespace = await openDocs(appKeyHex)
  await putRecord('probe', 'a', enc.encode('hello'))
  await putRecord('probe', 'b', enc.encode('world'))
  const a = await getRecord('probe', 'a')
  const list = await listRecords('probe')
  await deleteRecord('probe', 'a')
  const aAfter = await getRecord('probe', 'a')
  return [
    `namespace = ${namespace}`,
    `get a     = ${a ? dec.decode(a) : 'undefined'}`,
    `list probe = [${list.join(', ')}]`,
    `after delete a = ${aAfter ? dec.decode(aAfter) : 'undefined (ok)'}`,
  ].join('\n')
}
