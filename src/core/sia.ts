import { PinnedObject, type Sdk } from '@siafoundation/sia-storage'
import { CHANNEL_METADATA_VERSION, type ChannelMetadata } from './types'

// 1-byte sentinel: keeps the channel's object ID (and share URL) stable forever; all mutable state lives in metadata.
const CHANNEL_MARKER = new Uint8Array([0x01])
// Year-9999 makes channel share URLs effectively permanent (verified by Day-0 probe 2).
const FAR_FUTURE = new Date('9999-12-31T00:00:00Z')

export type CreatedChannel = {
  channel: ChannelMetadata
  channelUrl: string
}

export async function createChannel(
  sdk: Sdk,
  name: string,
  description: string,
): Promise<CreatedChannel> {
  const channel: ChannelMetadata = {
    version: CHANNEL_METADATA_VERSION,
    name,
    description,
    authorPubkey: sdk.appKey().publicKey(),
    createdAt: new Date().toISOString(),
    items: [],
  }

  const obj = await sdk.upload(
    new PinnedObject(),
    new Blob([CHANNEL_MARKER as BlobPart]).stream(),
  )
  obj.updateMetadata(new TextEncoder().encode(JSON.stringify(channel)))
  await sdk.pinObject(obj)
  await sdk.updateObjectMetadata(obj)

  return {
    channel,
    channelUrl: sdk.shareObject(obj, FAR_FUTURE),
  }
}

export async function fetchChannel(
  sdk: Sdk,
  channelUrl: string,
): Promise<ChannelMetadata> {
  const obj = await sdk.sharedObject(channelUrl)
  const parsed = JSON.parse(new TextDecoder().decode(obj.metadata()))
  if (parsed?.version !== CHANNEL_METADATA_VERSION) {
    throw new Error(
      `Unsupported channel metadata version (got ${parsed?.version}, expected ${CHANNEL_METADATA_VERSION})`,
    )
  }
  return parsed as ChannelMetadata
}
