// The doc-engine binding — the app's one interface to iroh-docs, the atproto repo's
// replacement. Records are keyed by (collection, rkey), values are opaque bytes
// (the same encrypted blob the app writes to atproto today).
//
// B1: browser only, via the wasm pin-core module. B2 will add the desktop transport
// (Tauri IPC to the native Curator) behind this same surface, picked by inTauri()
// — the curator.ts / desktop.ts pattern. For now everything routes through wasm.

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

let wasmReady: Promise<void> | null = null
function ensureReady(): Promise<void> {
  if (!wasmReady) wasmReady = initWasm().then(() => undefined)
  return wasmReady
}

/** Open/create the doc for this identity (namespace + author derived from the Sia
 *  AppKey). Returns the namespace id. */
export async function openDocs(appKeyHex: string): Promise<string> {
  await ensureReady()
  return coreOpen(appKeyHex)
}

export async function putRecord(
  collection: string,
  rkey: string,
  value: Uint8Array,
): Promise<void> {
  await ensureReady()
  await put_record(collection, rkey, value)
}

export async function getRecord(
  collection: string,
  rkey: string,
): Promise<Uint8Array | undefined> {
  await ensureReady()
  return get_record(collection, rkey) ?? undefined
}

export async function deleteRecord(
  collection: string,
  rkey: string,
): Promise<void> {
  await ensureReady()
  await delete_record(collection, rkey)
}

export async function listRecords(collection: string): Promise<string[]> {
  await ensureReady()
  return (await list_records(collection)) as string[]
}

/** Every record across all collections, as {collection, rkey} pairs. Used to
 *  snapshot the whole doc (docsMirror). */
export async function listAll(): Promise<
  Array<{ collection: string; rkey: string }>
> {
  await ensureReady()
  const keys = (await list_all()) as string[]
  return keys.map((key) => {
    const i = key.indexOf('/')
    return { collection: key.slice(0, i), rkey: key.slice(i + 1) }
  })
}

/** Produce a shareable DocTicket for this identity's doc (write cap + relay addr).
 *  A peer imports it via {@link startSync} to live-sync. Symmetric with the Curator's
 *  ticket — useful as a tab-to-tab sync counterpart during dev. Requires an open doc
 *  ({@link openDocs}). */
export async function shareDoc(): Promise<string> {
  await ensureReady()
  return coreShare()
}

/** Join the peer(s) in `ticket` and live-sync this identity's doc with them —
 *  the front end of the Curator. `onEvent` fires with a short label per sync event
 *  (insert-local / insert-remote / sync-finished / neighbor-up|down). The doc must
 *  already be open ({@link openDocs}); the same-namespace Curator is the peer. */
export async function startSync(
  ticket: string,
  onEvent: (label: string) => void,
): Promise<void> {
  await ensureReady()
  await coreStartSync(ticket, onEvent)
}

/** Dev-only Vite⨉wasm proof: open + put + get + list + delete roundtrip through the
 *  real bindings. Exposed on window in main.tsx (dev). */
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
