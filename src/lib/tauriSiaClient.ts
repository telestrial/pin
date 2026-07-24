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
import type { PinnedObjectInfo, SiaClient } from '../core/siaClient'
import type { UploadedItem } from '../core/sia'

// base64-encode in chunks — String.fromCharCode(...bytes) blows the call stack on
// large uploads, and a per-byte loop is slow for MB-scale media.
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...(bytes.subarray(i, i + CHUNK) as unknown as number[]),
    )
  }
  return btoa(binary)
}

type UploadDto = { id: string; itemUrl: string }

// Build an UploadedItem from the Rust upload result. The content hash (CIDv1) is
// computed here in TS so the CID logic stays in one place (core/contentHash), and
// byteSize is the plaintext length we already hold.
function toUploadedItem(dto: UploadDto, bytes: Uint8Array): Promise<UploadedItem> {
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
      const dto = await invoke<UploadDto>('sia_upload_item', {
        bytesBase64: toBase64(bytes),
      })
      return toUploadedItem(dto, bytes)
    },
    uploadItemsPacked: async (items) => {
      const dtos = await invoke<UploadDto[]>('sia_upload_items_packed', {
        itemsBase64: items.map(toBase64),
      })
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
      invoke<PinnedObjectInfo | null>('sia_get_object_slabs', { objectId: objectID }),

    appKeyPublicKey: () => publicKey,
  }
}
