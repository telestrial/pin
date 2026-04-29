import { PinnedObject, type Sdk } from '@siafoundation/sia-storage'
import { FAR_FUTURE } from './sia'
import {
  CHANNEL_METADATA_VERSION,
  type ChannelMetadata,
  type ItemRef,
} from './types'

export async function publishTextItem(
  sdk: Sdk,
  channelID: string,
  title: string,
  markdown: string,
  summary?: string,
): Promise<ChannelMetadata> {
  const itemBytes = new TextEncoder().encode(markdown)

  const itemObj = await sdk.upload(
    new PinnedObject(),
    new Blob([itemBytes as BlobPart]).stream(),
  )
  await sdk.pinObject(itemObj)

  const itemRef: ItemRef = {
    id: itemObj.id(),
    itemURL: sdk.shareObject(itemObj, FAR_FUTURE),
    type: 'text',
    title,
    summary,
    publishedAt: new Date().toISOString(),
    mimeType: 'text/markdown',
    byteSize: itemBytes.length,
  }

  const channelObj = await sdk.object(channelID)
  const current = JSON.parse(
    new TextDecoder().decode(channelObj.metadata()),
  ) as ChannelMetadata
  if (current.version !== CHANNEL_METADATA_VERSION) {
    throw new Error(
      `Unsupported channel metadata version (got ${current.version}, expected ${CHANNEL_METADATA_VERSION})`,
    )
  }

  const updated: ChannelMetadata = {
    ...current,
    items: [itemRef, ...current.items],
  }

  channelObj.updateMetadata(new TextEncoder().encode(JSON.stringify(updated)))
  await sdk.updateObjectMetadata(channelObj)

  return updated
}
