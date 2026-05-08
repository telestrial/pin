import { PinnedObject, type Sdk } from '@siafoundation/sia-storage'

// Year-9999 makes item share URLs effectively permanent (verified by Day-0 probe 2).
export const FAR_FUTURE = new Date('9999-12-31T00:00:00Z')

export type UploadedItem = {
  id: string
  itemURL: string
  byteSize: number
}

export async function uploadItem(
  sdk: Sdk,
  bytes: Uint8Array,
  onShard?: () => void,
): Promise<UploadedItem> {
  const obj = await sdk.upload(
    new PinnedObject(),
    new Blob([bytes as BlobPart]).stream(),
    onShard ? { onShardUploaded: () => onShard() } : undefined,
  )
  await sdk.pinObject(obj)
  return {
    id: obj.id(),
    itemURL: sdk.shareObject(obj, FAR_FUTURE),
    byteSize: bytes.length,
  }
}

// Bin-pack multiple objects into shared slabs. Each input gets its own
// PinnedObject + share URL out (callers can address them independently),
// but they share underlying slab capacity — so a post + 3 attachments
// that all fit in one 40 MiB slab consumes 1 slab worth of pinnedData
// instead of 4. Returns UploadedItems in the same order as inputs.
export async function uploadItemsPacked(
  sdk: Sdk,
  items: Uint8Array[],
  onShard?: () => void,
): Promise<UploadedItem[]> {
  const packed = sdk.uploadPacked(
    onShard ? { onShardUploaded: () => onShard() } : undefined,
  )
  for (const bytes of items) {
    await packed.add(new Blob([bytes as BlobPart]).stream())
  }
  const objects = await packed.finalize()
  const results: UploadedItem[] = []
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i]
    await sdk.pinObject(obj)
    results.push({
      id: obj.id(),
      itemURL: sdk.shareObject(obj, FAR_FUTURE),
      byteSize: items[i].length,
    })
  }
  return results
}

export async function downloadItem(
  sdk: Sdk,
  itemURL: string,
): Promise<Uint8Array> {
  const obj = await sdk.sharedObject(itemURL)
  const stream = sdk.download(obj)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
