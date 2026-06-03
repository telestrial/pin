import type { Agent } from '@atproto/api'
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
  type AttachmentRef,
  CHANNEL_MANIFEST_VERSION,
  type ChannelCover,
  type ChannelManifest,
  type ChannelVisibility,
  type ItemRef,
  type ItemType,
} from './types'

export type CreatedChannel = {
  channelID: string
  channelKey: string // base64
  manifest: ChannelManifest
  subscribeURL: string
}

export type AttachmentSource =
  | {
      kind: 'url'
      url: string
      mimeType: string
      filename?: string
      byteSize: number
      // Carried through from the source ItemRef when re-attaching an
      // already-uploaded library item; lets the resulting AttachmentRef
      // keep a stable cache key and a known objectID even though we
      // never re-fetch the bytes.
      contentHash?: string
      objectID?: string
    }
  | { kind: 'bytes'; bytes: Uint8Array; mimeType: string; filename: string }

export type ItemPayload = {
  type: ItemType
  title: string
  summary?: string
  mimeType: string
  bytes: Uint8Array
  durationMs?: number
  filename?: string
  attachments?: AttachmentRef[]
  attachmentSources?: AttachmentSource[]
}

export async function createChannel(
  sdk: Sdk,
  agent: Agent,
  authorHandle: string,
  args: {
    name: string
    description: string
    // Sticky-at-creation per the visibility design. Defaults to 'public'
    // since starting fresh — every legacy channel was effectively obscure
    // (no follow primitive existed) and the new shape leans toward
    // discoverable-by-default for the Twitter-shape experience.
    visibility?: ChannelVisibility
    coverImage?: { bytes: Uint8Array; mimeType: string }
  },
): Promise<CreatedChannel> {
  const did = agent.assertDid

  const keyBytes = await generateChannelKey()
  const channelKey = channelKeyToBase64(keyBytes)
  const channelID = await deriveChannelID(keyBytes)

  let coverArt: ChannelManifest['coverArt']
  if (args.coverImage) {
    const uploaded = await uploadItem(sdk, args.coverImage.bytes)
    coverArt = {
      itemURL: uploaded.itemURL,
      mimeType: args.coverImage.mimeType,
      contentHash: uploaded.contentHash,
    }
  }

  const manifest: ChannelManifest = {
    version: CHANNEL_MANIFEST_VERSION,
    name: args.name,
    description: args.description,
    authorPubkey: sdk.appKey().publicKey(),
    authorATProtoDID: did,
    publishedAt: new Date().toISOString(),
    visibility: args.visibility ?? 'public',
    coverArt,
    items: [],
  }

  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(manifest))
  await putChannelRecord(
    agent,
    channelID,
    ciphertext,
    manifest.visibility === 'public' ? channelKey : undefined,
  )

  return {
    channelID,
    channelKey,
    manifest,
    subscribeURL: buildSubscribeURL(authorHandle, channelKey),
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
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  patch: EditChannelPatch,
): Promise<ChannelManifest> {
  const did = agent.assertDid

  const current = await fetchChannel(
    did,
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
      contentHash: uploaded.contentHash,
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
  await putChannelRecord(
    agent,
    channel.channelID,
    ciphertext,
    updated.visibility === 'public' ? channel.channelKey : undefined,
  )

  return updated
}

// channelKey is optional: for public channels, K is embedded in the
// record body itself so a caller that doesn't have K (e.g. a directory
// page walking a follow list) can still decrypt. For obscure channels,
// callers must supply K — otherwise we have no way to read the manifest.
export async function fetchChannel(
  authorHandleOrDID: string,
  channelID: string,
  channelKey?: string,
): Promise<ChannelManifest> {
  const record = await getChannelRecord(authorHandleOrDID, channelID)
  const keyB64 = channelKey ?? record.key
  if (!keyB64) {
    throw new Error(
      'Channel is obscure (no key in record) and no channel key supplied',
    )
  }
  const keyBytes = channelKeyFromBase64(keyB64)
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
  uploaded: {
    id: string
    itemURL: string
    byteSize: number
    contentHash: string
  },
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
    attachments: payload.attachments,
    contentHash: uploaded.contentHash,
  }
}

export async function unpinChannel(
  sdk: Sdk,
  agent: Agent,
  channel: { channelID: string; channelKey: string },
): Promise<void> {
  const did = agent.assertDid

  const manifest = await fetchChannel(
    did,
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
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  itemID: string,
): Promise<ChannelManifest> {
  const did = agent.assertDid

  const current = await fetchChannel(
    did,
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
  await putChannelRecord(
    agent,
    channel.channelID,
    ciphertext,
    updated.visibility === 'public' ? channel.channelKey : undefined,
  )

  await sdk.deleteObject(itemID)

  return updated
}

export async function editItem(
  sdk: Sdk,
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  oldItemID: string,
  newItem: ItemRef,
  removedAttachmentObjectIDs?: string[],
): Promise<{ manifest: ChannelManifest; item: ItemRef }> {
  const did = agent.assertDid

  const current = await fetchChannel(
    did,
    channel.channelID,
    channel.channelKey,
  )
  const oldIndex = current.items.findIndex((i) => i.id === oldItemID)
  if (oldIndex === -1) throw new Error('Item not found in channel')
  const oldItem = current.items[oldIndex]

  // Preserve original publishedAt — chronology doesn't change on edit.
  // Caller is responsible for stamping editedAt on the incoming ItemRef.
  const finalItem: ItemRef = { ...newItem, publishedAt: oldItem.publishedAt }

  const updatedItems = [...current.items]
  updatedItems[oldIndex] = finalItem

  const updated: ChannelManifest = {
    ...current,
    publishedAt: new Date().toISOString(),
    items: updatedItems,
  }

  const keyBytes = channelKeyFromBase64(channel.channelKey)
  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(updated))
  await putChannelRecord(
    agent,
    channel.channelID,
    ciphertext,
    updated.visibility === 'public' ? channel.channelKey : undefined,
  )

  // Drop old bytes best-effort; subscribers who pinned keep their snapshot.
  sdk.deleteObject(oldItemID).catch(() => {})

  // Drop removed-attachment bytes best-effort. Subscribers who pinned
  // those attachments keep their snapshots too.
  for (const id of removedAttachmentObjectIDs ?? []) {
    sdk.deleteObject(id).catch(() => {})
  }

  return { manifest: updated, item: finalItem }
}

export async function appendItemToChannel(
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  itemRef: ItemRef,
): Promise<ChannelManifest> {
  const did = agent.assertDid

  const current = await fetchChannel(
    did,
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
  await putChannelRecord(
    agent,
    channel.channelID,
    ciphertext,
    updated.visibility === 'public' ? channel.channelKey : undefined,
  )

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
