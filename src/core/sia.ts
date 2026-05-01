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
