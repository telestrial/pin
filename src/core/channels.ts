import type { AtpAgent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import {
  getChannelRecord,
  putChannelRecord,
} from './atproto'
import {
  channelKeyFromBase64,
  channelKeyToBase64,
  decryptForChannel,
  encryptForChannel,
  generateChannelKey,
} from './crypto'
import { downloadItem, uploadItem } from './sia'
import {
  CHANNEL_MANIFEST_VERSION,
  type ChannelManifest,
  type ItemRef,
  type ItemType,
} from './types'

export type CreatedChannel = {
  channelHandle: string
  channelKey: string             // base64
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
}

export async function createChannel(
  sdk: Sdk,
  agent: AtpAgent,
  args: { name: string; description: string; channelHandle: string },
): Promise<CreatedChannel> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')

  const keyBytes = await generateChannelKey()
  const channelKey = channelKeyToBase64(keyBytes)

  const manifest: ChannelManifest = {
    version: CHANNEL_MANIFEST_VERSION,
    name: args.name,
    description: args.description,
    authorPubkey: sdk.appKey().publicKey(),
    authorATProtoDID: session.did,
    channelHandle: args.channelHandle,
    publishedAt: new Date().toISOString(),
    items: [],
  }

  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(manifest))
  await putChannelRecord(agent, args.channelHandle, ciphertext)

  return {
    channelHandle: args.channelHandle,
    channelKey,
    manifest,
    subscribeURL: buildSubscribeURL(session.handle, args.channelHandle, channelKey),
  }
}

export async function fetchChannel(
  authorHandleOrDID: string,
  channelHandle: string,
  channelKey: string,
): Promise<ChannelManifest> {
  const record = await getChannelRecord(authorHandleOrDID, channelHandle)
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

export async function publishItem(
  sdk: Sdk,
  agent: AtpAgent,
  channel: { channelHandle: string; channelKey: string },
  payload: ItemPayload,
): Promise<{ manifest: ChannelManifest; itemRef: ItemRef }> {
  const uploaded = await uploadItem(sdk, payload.bytes)

  const itemRef: ItemRef = {
    id: uploaded.id,
    itemURL: uploaded.itemURL,
    type: payload.type,
    title: payload.title,
    summary: payload.summary,
    publishedAt: new Date().toISOString(),
    mimeType: payload.mimeType,
    byteSize: uploaded.byteSize,
    durationMs: payload.durationMs,
  }

  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')

  // Re-fetch the latest manifest (publisher's own — guaranteed decrypt-able).
  const current = await fetchChannel(
    session.did,
    channel.channelHandle,
    channel.channelKey,
  )

  const updated: ChannelManifest = {
    ...current,
    publishedAt: new Date().toISOString(),
    items: [itemRef, ...current.items],
  }

  const keyBytes = channelKeyFromBase64(channel.channelKey)
  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(updated))
  await putChannelRecord(agent, channel.channelHandle, ciphertext)

  return { manifest: updated, itemRef }
}

export async function downloadItemBytes(
  sdk: Sdk,
  itemURL: string,
): Promise<Uint8Array> {
  return downloadItem(sdk, itemURL)
}

export function buildSubscribeURL(
  authorHandle: string,
  channelHandle: string,
  channelKey: string,
): string {
  return `dispatch://${authorHandle}/${channelHandle}#k=${channelKey}`
}

export function parseSubscribeURL(url: string): {
  authorHandle: string
  channelHandle: string
  channelKey: string
} {
  const m = url
    .trim()
    .match(/^dispatch:\/\/([^/]+)\/([^#]+)#k=(.+)$/)
  if (!m) {
    throw new Error('Invalid subscribe URL (expected dispatch://<handle>/<channel>#k=<key>)')
  }
  const [, authorHandle, channelHandle, channelKey] = m
  return { authorHandle, channelHandle, channelKey }
}
