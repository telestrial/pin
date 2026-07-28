// The DESKTOP SiaClient — native Sia I/O over the Rust `sia_storage` backend
// (src-tauri/src/sia.rs), reached via Tauri IPC. Satisfies the same `SiaClient`
// interface as the web WASM client, so nothing downstream changes; the fork lives
// in connectSiaClient.ts, which dynamically imports this module only under Tauri
// (so `@tauri-apps/api` never enters the web bundle).
//
// This is what fixes the WebView2 `download` wart — the byte-stream read happens
// natively in Rust, not in the webview's WASM SDK.

import { computeContentHash } from '../core/contentHash'
import type { AccountSnapshot } from '../core/pin'
import type { UploadedItem } from '../core/sia'
import type { PinnedObjectInfo, SiaClient } from '../core/siaClient'

// Frame N buffers into one raw payload — [u32 count][u32 len][bytes]...
// little-endian — since a raw IPC body is a single blob. Rust's `unframe` splits
// it back. Keeps packed uploads on the raw path (no base64) like single uploads.
function frameBuffers(items: Uint8Array[]): Uint8Array {
  const total = 4 + items.reduce((n, b) => n + 4 + b.length, 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  let off = 0
  dv.setUint32(off, items.length, true)
  off += 4
  for (const b of items) {
    dv.setUint32(off, b.length, true)
    off += 4
    out.set(b, off)
    off += b.length
  }
  return out
}

type UploadDto = { id: string; itemUrl: string }

// Build an UploadedItem from the Rust upload result. The content hash (CIDv1) is
// computed here in TS so the CID logic stays in one place (core/contentHash), and
// byteSize is the plaintext length we already hold.
function toUploadedItem(
  dto: UploadDto,
  bytes: Uint8Array,
): Promise<UploadedItem> {
  return computeContentHash(bytes).then((contentHash) => ({
    id: dto.id,
    itemURL: dto.itemUrl,
    byteSize: bytes.length,
    contentHash,
  }))
}

export async function makeTauriSiaClient(
  appKeyHex: string,
  indexerURL: string,
  // Captured from the WASM AppKey at connect time so appKeyPublicKey() stays
  // synchronous AND its string format matches the web client exactly.
  publicKey: string,
): Promise<SiaClient> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('sia_connect', { appKeyHex, indexerUrl: indexerURL })

  return {
    // NOTE: onShard progress callbacks aren't marshalled over IPC in this first
    // cut — the upload still completes; per-shard progress bars just won't tick on
    // desktop. A Tauri event channel can drive them later.
    uploadItem: async (bytes) => {
      // Pass the Uint8Array as the payload → Tauri sends it as a raw request body
      // (no JSON number-array / base64 blow-up), read on the Rust side as InvokeBody::Raw.
      const dto = await invoke<UploadDto>('sia_upload_item', bytes)
      return toUploadedItem(dto, bytes)
    },
    uploadItemsPacked: async (items) => {
      const dtos = await invoke<UploadDto[]>(
        'sia_upload_items_packed',
        frameBuffers(items),
      )
      return Promise.all(dtos.map((dto, i) => toUploadedItem(dto, items[i])))
    },
    downloadItem: async (url) => {
      const buf = await invoke<ArrayBuffer>('sia_download_item', { url })
      return new Uint8Array(buf)
    },

    pinFromShareURL: async (url) => ({
      objectID: await invoke<string>('sia_pin_from_share_url', { url }),
    }),
    resolveObjectID: (url) => invoke<string>('sia_resolve_object_id', { url }),
    deleteObject: (id) => invoke<void>('sia_delete_object', { id }),
    pruneSlabs: () => invoke<void>('sia_prune_slabs'),

    accountSnapshot: () => invoke<AccountSnapshot>('sia_account_snapshot'),
    listPinnedObjects: () =>
      invoke<PinnedObjectInfo[]>('sia_list_pinned_objects'),
    getObjectSlabs: (objectID) =>
      invoke<PinnedObjectInfo | null>('sia_get_object_slabs', {
        objectId: objectID,
      }),

    appKeyPublicKey: () => publicKey,
  }
}
