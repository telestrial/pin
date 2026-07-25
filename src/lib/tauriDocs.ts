// The desktop transport for the doc engine — Tauri IPC to the native Curator's
// PERSISTENT iroh-docs replica (the same one it serves over iroh), mirroring the
// src/lib/docs.ts record surface. Slice B routes docs.ts through here on desktop
// (picked by inTauri()); Slice A exposes it for a dev self-test that proves the IPC
// round-trip. The Tauri IPC module is dynamically imported so it never enters the web
// bundle — the tauriSiaClient.ts / tauriPkarr.ts pattern.
//
// Record identity + value semantics match pin-core (the wasm engine): key is
// `collection/rkey`, value is opaque bytes (the app's encrypted blob). Byte values
// ride as plain JSON number arrays — fine at record scale (settings / channel
// manifests are KB; media bytes live on Sia, never in a record). Every call rejects
// with "Curator is not running" when the engine is down.

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/** The running Curator doc's namespace id, or null if the engine isn't up — the
 *  desktop equivalent of docs.ts `openDocs` (the native Curator opens the doc itself
 *  at start, so this reads the id rather than opening). */
export function docsNamespaceNative(): Promise<string | null> {
  return call<string | null>('docs_namespace')
}

export function putRecordNative(
  collection: string,
  rkey: string,
  value: Uint8Array,
): Promise<void> {
  return call<void>('docs_put_record', {
    collection,
    rkey,
    value: Array.from(value),
  })
}

export async function getRecordNative(
  collection: string,
  rkey: string,
): Promise<Uint8Array | undefined> {
  const v = await call<number[] | null>('docs_get_record', { collection, rkey })
  return v ? new Uint8Array(v) : undefined
}

export function deleteRecordNative(
  collection: string,
  rkey: string,
): Promise<void> {
  return call<void>('docs_delete_record', { collection, rkey })
}

export function listRecordsNative(collection: string): Promise<string[]> {
  return call<string[]>('docs_list_records', { collection })
}

export async function listAllNative(): Promise<
  Array<{ collection: string; rkey: string }>
> {
  const keys = await call<string[]>('docs_list_all')
  return keys.map((key) => {
    const i = key.indexOf('/')
    return { collection: key.slice(0, i), rkey: key.slice(i + 1) }
  })
}

/** Slice A proof: drive the native Curator doc through put / get / list / delete over
 *  IPC and report. Requires the Curator to be running (enable curation first). */
export async function curatorDocsSelfTest(): Promise<string> {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const ns = await docsNamespaceNative()
  if (!ns) return 'Curator not running — enable curation first, then retry'
  await putRecordNative('probe', 'a', enc.encode('hello'))
  await putRecordNative('probe', 'b', enc.encode('world'))
  const a = await getRecordNative('probe', 'a')
  const list = await listRecordsNative('probe')
  const all = await listAllNative()
  await deleteRecordNative('probe', 'a')
  const aAfter = await getRecordNative('probe', 'a')
  return [
    `namespace     = ${ns}`,
    `get probe/a   = ${a ? dec.decode(a) : 'undefined'}`,
    `list probe    = [${list.join(', ')}]`,
    `list all      = [${all.map((k) => `${k.collection}/${k.rkey}`).join(', ')}]`,
    `after delete a = ${aAfter ? dec.decode(aAfter) : 'undefined (ok)'}`,
  ].join('\n')
}
