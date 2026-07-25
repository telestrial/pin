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
  delete_record,
  get_record,
  list_all,
  list_records,
  put_record,
} from '../../crates/pin-core/pkg/pin_core.js'
import { inTauri } from './openExternal'
import {
  deleteRecordNative,
  getRecordNative,
  listAllNative,
  listRecordsNative,
  openDocsNative,
  putRecordNative,
  shareDocNative,
} from './tauriDocs'

let wasmReady: Promise<void> | null = null
function ensureReady(): Promise<void> {
  if (!wasmReady) wasmReady = initWasm().then(() => undefined)
  return wasmReady
}

/** Open/create the doc for this identity (namespace + author derived from the Sia
 *  AppKey). Returns the namespace id. On desktop this waits for the auto-started
 *  Curator's doc; on web it opens the in-page wasm engine. */
export async function openDocs(appKeyHex: string): Promise<string> {
  if (inTauri()) return openDocsNative()
  await ensureReady()
  return coreOpen(appKeyHex)
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

/** Join the peer(s) in `ticket` and live-sync this identity's doc with them —
 *  the front end of the Curator. `onEvent` fires with a short label per sync event
 *  (insert-local / insert-remote / sync-finished / neighbor-up|down). The doc must
 *  already be open ({@link openDocs}); the same-namespace Curator is the peer.
 *
 *  Web (wasm) only for now. On desktop, live-sync is the Curator's own job (its
 *  serve/pull loops), not something driven through this binding — wiring that is the
 *  sync arc, not this slice. */
export async function startSync(
  ticket: string,
  onEvent: (label: string) => void,
): Promise<void> {
  if (inTauri()) {
    throw new Error('desktop live-sync runs in the Curator, not via docs.ts')
  }
  await ensureReady()
  await coreStartSync(ticket, onEvent)
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
