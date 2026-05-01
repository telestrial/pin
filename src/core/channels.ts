import type { AtpAgent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import {
  deleteChannelRecord,
  getChannelRecord,
  putChannelRecord,
} from './atproto'
import {
  channelKeyFromBase64,
  channelKeyToBase64,
  decryptForChannel,
  deriveChannelID,
  encryptForChannel,
  generateChannelKey,
} from './crypto'
import { downloadItem, uploadItem } from './sia'
import {
  CHANNEL_MANIFEST_VERSION,
  type ChannelCover,
  type ChannelManifest,
  type ItemRef,
  type ItemType,
} from './types'

export type CreatedChannel = {
  channelID: string
  channelKey: string // base64
  manifest: ChannelManifest
  subscribeURL: string
}

export type ItemPayload = {
  type: ItemType
  title: string
  summary?: string
  mimeType: string
  bytes: Uint8Array
  durationMs?: number
  filename?: string
}

export async function createChannel(
  sdk: Sdk,
  agent: AtpAgent,
  args: {
    name: string
    description: string
    coverImage?: { bytes: Uint8Array; mimeType: string }
  },
): Promise<CreatedChannel> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')

  const keyBytes = await generateChannelKey()
  const channelKey = channelKeyToBase64(keyBytes)
  const channelID = await deriveChannelID(keyBytes)

  let coverArt: ChannelManifest['coverArt']
  if (args.coverImage) {
    const uploaded = await uploadItem(sdk, args.coverImage.bytes)
    coverArt = { itemURL: uploaded.itemURL, mimeType: args.coverImage.mimeType }
  }

  const manifest: ChannelManifest = {
    version: CHANNEL_MANIFEST_VERSION,
    name: args.name,
    description: args.description,
    authorPubkey: sdk.appKey().publicKey(),
    authorATProtoDID: session.did,
    publishedAt: new Date().toISOString(),
    coverArt,
    items: [],
  }

  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(manifest))
  await putChannelRecord(agent, channelID, ciphertext)

  return {
    channelID,
    channelKey,
    manifest,
    subscribeURL: buildSubscribeURL(session.handle, channelKey),
  }
}

export type EditChannelPatch = {
  name?: string
  description?: string
  coverImage?: { bytes: Uint8Array; mimeType: string }
  removeCover?: boolean
}

export async function editChannel(
  sdk: Sdk,
  agent: AtpAgent,
  channel: { channelID: string; channelKey: string },
  patch: EditChannelPatch,
): Promise<ChannelManifest> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')

  const current = await fetchChannel(
    session.did,
    channel.channelID,
    channel.channelKey,
  )

  let coverArt: ChannelCover | undefined = current.coverArt
  if (patch.removeCover) {
    coverArt = undefined
  } else if (patch.coverImage) {
    const uploaded = await uploadItem(sdk, patch.coverImage.bytes)
    coverArt = {
      itemURL: uploaded.itemURL,
      mimeType: patch.coverImage.mimeType,
    }
  }

  const updated: ChannelManifest = {
    ...current,
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    coverArt,
    publishedAt: new Date().toISOString(),
  }

  const keyBytes = channelKeyFromBase64(channel.channelKey)
  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(updated))
  await putChannelRecord(agent, channel.channelID, ciphertext)

  return updated
}

export async function fetchChannel(
  authorHandleOrDID: string,
  channelID: string,
  channelKey: string,
): Promise<ChannelManifest> {
  const record = await getChannelRecord(authorHandleOrDID, channelID)
  const keyBytes = channelKeyFromBase64(channelKey)
  const plaintext = await decryptForChannel(keyBytes, record.encryptedManifest)
  const parsed = JSON.parse(plaintext)
  if (parsed?.version !== CHANNEL_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported channel manifest version (got ${parsed?.version}, expected ${CHANNEL_MANIFEST_VERSION})`,
    )
  }
  return parsed as ChannelManifest
}

export function buildItemRef(
  uploaded: { id: string; itemURL: string; byteSize: number },
  payload: ItemPayload,
): ItemRef {
  return {
    id: uploaded.id,
    itemURL: uploaded.itemURL,
    type: payload.type,
    title: payload.title,
    summary: payload.summary,
    publishedAt: new Date().toISOString(),
    mimeType: payload.mimeType,
    byteSize: uploaded.byteSize,
    durationMs: payload.durationMs,
    filename: payload.filename,
  }
}

export async function unpinChannel(
  sdk: Sdk,
  agent: AtpAgent,
  channel: { channelID: string; channelKey: string },
): Promise<void> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')

  const manifest = await fetchChannel(
    session.did,
    channel.channelID,
    channel.channelKey,
  )

  for (const item of manifest.items) {
    try {
      await sdk.deleteObject(item.id)
    } catch (e) {
      console.warn(`Failed to delete item ${item.id}:`, e)
    }
  }

  if (manifest.coverArt) {
    try {
      const handle = await sdk.sharedObject(manifest.coverArt.itemURL)
      await sdk.deleteObject(handle.id())
    } catch (e) {
      console.warn('Failed to delete cover art:', e)
    }
  }

  await deleteChannelRecord(agent, channel.channelID)
}

export async function deletePublishedItem(
  sdk: Sdk,
  agent: AtpAgent,
  channel: { channelID: string; channelKey: string },
  itemID: string,
): Promise<ChannelManifest> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')

  const current = await fetchChannel(
    session.did,
    channel.channelID,
    channel.channelKey,
  )

  const updated: ChannelManifest = {
    ...current,
    publishedAt: new Date().toISOString(),
    items: current.items.filter((i) => i.id !== itemID),
  }

  const keyBytes = channelKeyFromBase64(channel.channelKey)
  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(updated))
  await putChannelRecord(agent, channel.channelID, ciphertext)

  await sdk.deleteObject(itemID)

  return updated
}

export async function appendItemToChannel(
  agent: AtpAgent,
  channel: { channelID: string; channelKey: string },
  itemRef: ItemRef,
): Promise<ChannelManifest> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')

  const current = await fetchChannel(
    session.did,
    channel.channelID,
    channel.channelKey,
  )

  const updated: ChannelManifest = {
    ...current,
    publishedAt: new Date().toISOString(),
    items: [itemRef, ...current.items],
  }

  const keyBytes = channelKeyFromBase64(channel.channelKey)
  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(updated))
  await putChannelRecord(agent, channel.channelID, ciphertext)

  return updated
}

export async function downloadItemBytes(
  sdk: Sdk,
  itemURL: string,
): Promise<Uint8Array> {
  return downloadItem(sdk, itemURL)
}

export function buildSubscribeURL(
  authorHandle: string,
  channelKey: string,
): string {
  return `pin://${authorHandle}#k=${channelKey}`
}

export async function parseSubscribeURL(url: string): Promise<{
  authorHandle: string
  channelID: string
  channelKey: string
}> {
  const m = url.trim().match(/^pin:\/\/([^#/]+)#k=(.+)$/)
  if (!m) {
    throw new Error(
      'Invalid subscribe URL (expected pin://<handle>#k=<key>)',
    )
  }
  const [, authorHandle, channelKey] = m
  const keyBytes = channelKeyFromBase64(channelKey)
  const channelID = await deriveChannelID(keyBytes)
  return { authorHandle, channelID, channelKey }
}
