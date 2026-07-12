import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import {
  CHANNEL_LEXICON,
  type ChannelRecord,
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
import {
  channelAtURI,
  rkeyForSubject,
  SUBSCRIPTION_LEXICON,
  type SubscriptionRecord,
} from './follow'
import { downloadItem, uploadItem } from './sia'
import {
  type AttachmentRef,
  CHANNEL_MANIFEST_VERSION,
  type ChannelImage,
  type ChannelManifest,
  type ChannelVisibility,
  type Facet,
  type ItemRef,
  type ItemType,
  isValidAttachment,
} from './types'

// Object IDs that survive an edit/retract and must therefore NOT be deleted:
// the post-edit manifest's own objects (body ids + attachment objectIDs) unioned
// with `external` — the caller's other-scope refs (other channels' manifests +
// pins). Eager cleanup deletes a candidate object only when it's absent here.
function survivingObjectIDs(
  manifest: ChannelManifest,
  external: ReadonlySet<string>,
): Set<string> {
  const set = new Set(external)
  for (const item of manifest.items) {
    set.add(item.id)
    for (const att of item.attachments ?? []) {
      if (isValidAttachment(att) && att.objectID) set.add(att.objectID)
    }
  }
  return set
}

// Upload an optional channel image (avatar or cover) to Sia and shape it into
// a ChannelImage ref. Shared by createChannel and editChannel.
async function uploadChannelImage(
  sdk: Sdk,
  img?: { bytes: Uint8Array; mimeType: string },
): Promise<ChannelImage | undefined> {
  if (!img) return undefined
  const uploaded = await uploadItem(sdk, img.bytes)
  return {
    itemURL: uploaded.itemURL,
    mimeType: img.mimeType,
    contentHash: uploaded.contentHash,
    byteSize: uploaded.byteSize,
  }
}

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
  // Mention (and future pin.itemLink) annotations over the body. Carried onto
  // the ItemRef by buildItemRef; the edit path preserves them via the passed ref.
  facets?: Facet[]
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
    avatarImage?: { bytes: Uint8Array; mimeType: string }
    coverImage?: { bytes: Uint8Array; mimeType: string }
  },
): Promise<CreatedChannel> {
  const did = agent.assertDid

  const keyBytes = await generateChannelKey()
  const channelKey = channelKeyToBase64(keyBytes)
  const channelID = await deriveChannelID(keyBytes)

  const avatar = await uploadChannelImage(sdk, args.avatarImage)
  const cover = await uploadChannelImage(sdk, args.coverImage)

  const manifest: ChannelManifest = {
    version: CHANNEL_MANIFEST_VERSION,
    name: args.name,
    description: args.description,
    authorPubkey: sdk.appKey().publicKey(),
    authorATProtoDID: did,
    publishedAt: new Date().toISOString(),
    visibility: args.visibility ?? 'public',
    avatar,
    cover,
    items: [],
  }

  const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(manifest))
  const isPublic = manifest.visibility === 'public'

  const channelRecord: ChannelRecord = {
    $type: CHANNEL_LEXICON,
    encryptedManifest: ciphertext,
    ...(isPublic && { key: channelKey }),
  }

  const writes: Array<{
    $type: 'com.atproto.repo.applyWrites#create'
    collection: string
    rkey: string
    value: Record<string, unknown>
  }> = [
    {
      $type: 'com.atproto.repo.applyWrites#create',
      collection: CHANNEL_LEXICON,
      rkey: channelID,
      value: channelRecord,
    },
  ]

  // Public channels are claimed at birth: the author self-follows in the
  // SAME atproto commit, so a channel is never momentarily public-but-
  // unclaimed. Obscure channels can't be followed (the AT-URI rkey derives
  // from K, so a public follow record would leak the channel's existence),
  // so they're never claimed and never surface under "Voices".
  if (isPublic) {
    const subject = channelAtURI(did, channelID)
    const subRecord: SubscriptionRecord = {
      $type: SUBSCRIPTION_LEXICON,
      subject,
      createdAt: manifest.publishedAt,
    }
    writes.push({
      $type: 'com.atproto.repo.applyWrites#create',
      collection: SUBSCRIPTION_LEXICON,
      rkey: await rkeyForSubject(subject),
      value: subRecord,
    })
  }

  await agent.com.atproto.repo.applyWrites({
    repo: did,
    validate: false,
    writes,
  })

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
  avatarImage?: { bytes: Uint8Array; mimeType: string }
  coverImage?: { bytes: Uint8Array; mimeType: string }
  removeAvatar?: boolean
  removeCover?: boolean
}

export async function editChannel(
  sdk: Sdk,
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  patch: EditChannelPatch,
): Promise<{ manifest: ChannelManifest; reclaimURLs: string[] }> {
  const did = agent.assertDid

  const current = await fetchChannel(did, channel.channelID, channel.channelKey)

  let avatar: ChannelImage | undefined = current.avatar
  if (patch.removeAvatar) {
    avatar = undefined
  } else if (patch.avatarImage) {
    avatar = await uploadChannelImage(sdk, patch.avatarImage)
  }

  let cover: ChannelImage | undefined = current.cover
  if (patch.removeCover) {
    cover = undefined
  } else if (patch.coverImage) {
    cover = await uploadChannelImage(sdk, patch.coverImage)
  }

  const updated: ChannelManifest = {
    ...current,
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    avatar,
    cover,
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

  // Old avatar/cover bytes a replace/remove orphaned. Per-object Sia encryption
  // gives each upload a unique objectID, so an old image is never shared with
  // another channel — handing back its URL for the caller to journal as a
  // delete-objects cleanup is reference-safe without a refcount check. Closes
  // the image-swap leak (these bytes previously just accumulated).
  const reclaimURLs: string[] = []
  if ((patch.removeAvatar || patch.avatarImage) && current.avatar) {
    reclaimURLs.push(current.avatar.itemURL)
  }
  if ((patch.removeCover || patch.coverImage) && current.cover) {
    reclaimURLs.push(current.cover.itemURL)
  }

  return { manifest: updated, reclaimURLs }
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
    facets: payload.facets,
    contentHash: uploaded.contentHash,
  }
}

export async function unpinChannel(
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  // Object IDs referenced elsewhere in the author's own scope (other channel
  // manifests + pins) — survive the retract, same reference-safety as
  // deletePublishedItem. Defaults to empty.
  protectedObjectIDs: ReadonlySet<string> = new Set(),
): Promise<{ objectIDs: string[]; urls: string[] }> {
  const did = agent.assertDid

  // Retract is idempotent. The channel record may already be gone — a prior
  // partial retract, a record deleted out-of-band, a stale local entry
  // pointing at nothing. If the manifest can't be fetched we can't enumerate
  // the item bytes to delete, but we still clear the record best-effort and
  // return empty lists so the caller drops its local state. The goal — "this
  // channel is gone" — is already met, and a ghost channel that can't be
  // retracted would otherwise wedge the UI (and the e2e cleanup loop) forever.
  let manifest: ChannelManifest | null = null
  try {
    manifest = await fetchChannel(did, channel.channelID, channel.channelKey)
  } catch (e) {
    if (!isRecordNotFoundError(e)) throw e
  }

  // Enumerate the channel's bytes before dropping the record. Items + their
  // attachment objects go in objectIDs (reference-filtered); avatar/cover go in
  // urls (the delete-objects action resolves URL→id). The caller journals these
  // as a durable, retried delete-objects action instead of a fire-and-forget
  // delete a QUIC blip could silently drop.
  const objectIDs: string[] = []
  const urls: string[] = []
  if (manifest) {
    for (const item of manifest.items) {
      if (!protectedObjectIDs.has(item.id)) objectIDs.push(item.id)
      for (const att of item.attachments ?? []) {
        if (!isValidAttachment(att) || !att.objectID) continue
        if (protectedObjectIDs.has(att.objectID)) continue
        objectIDs.push(att.objectID)
      }
    }
    for (const image of [manifest.avatar, manifest.cover]) {
      if (image) urls.push(image.itemURL)
    }
  }

  // Reliable leg first: drop the record (removes the reference) before the
  // byte-cleanup is journaled.
  try {
    await deleteChannelRecord(agent, channel.channelID)
  } catch (e) {
    if (!isRecordNotFoundError(e)) throw e
  }

  return { objectIDs, urls }
}

// Whether an atproto error means "the record isn't there" — so a delete can
// treat it as already-done. Mirrors the local helper in core/follow.ts; kept
// duplicated (small, two call sites) rather than coupling the modules.
function isRecordNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: number; error?: string; message?: string }
  if (e.error === 'RecordNotFound') return true
  return (
    e.status === 400 &&
    typeof e.message === 'string' &&
    /could not locate|not found|recordnotfound/i.test(e.message)
  )
}

// Identify "ghost" owned channels: entries in the user's channel list whose
// atproto record no longer exists. These arise when a retract deletes the
// channel record but the follow-up settings save fails — the record is gone
// but the settings entry is orphaned, so the channel resurrects on the next
// load from stale settings. Reconciliation prunes them.
//
// Only a DEFINITIVE RecordNotFound counts. A transient network failure (QUIC
// idle-timeout, 502, host churn) returns the channel as "not a ghost" so a
// blip can never delete a real channel — at worst reconciliation is a no-op
// that retries next load.
export async function reconcileGhostChannels(
  authorDID: string,
  channelIDs: string[],
): Promise<string[]> {
  const results = await Promise.all(
    channelIDs.map(async (channelID) => {
      try {
        await getChannelRecord(authorDID, channelID)
        return null
      } catch (e) {
        return isRecordNotFoundError(e) ? channelID : null
      }
    }),
  )
  return results.filter((id): id is string => id !== null)
}

export async function deletePublishedItem(
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  itemID: string,
  // Object IDs referenced elsewhere in the author's own scope (other channel
  // manifests + pins). Bytes in this set survive the retract — a file shared
  // with another of your posts, or held by a standalone library pin, isn't
  // yanked out from under it. Defaults to empty; callers pass their in-memory
  // scope refs to make the reference-safe prune correct.
  protectedObjectIDs: ReadonlySet<string> = new Set(),
): Promise<{ manifest: ChannelManifest; orphanedObjectIDs: string[] }> {
  const did = agent.assertDid

  const current = await fetchChannel(did, channel.channelID, channel.channelKey)
  const removed = current.items.find((i) => i.id === itemID)

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

  // Reference-safe prune: the reliable leg (the record write above) is done, so
  // collect the body + every attachment whose bytes nothing surviving still
  // references, and hand them back. The caller journals them as a delete-objects
  // action — a durable, retried byte-cleanup — instead of a best-effort delete
  // that a QUIC blip could silently drop. Subscribers' pinned copies live in
  // their own scope, so this never touches them. (Legacy attachments without an
  // objectID can't be enumerated here; they're a known, bounded gap.)
  const surviving = survivingObjectIDs(updated, protectedObjectIDs)
  const orphanedObjectIDs: string[] = []
  if (!surviving.has(itemID)) orphanedObjectIDs.push(itemID)
  for (const att of removed?.attachments ?? []) {
    if (!isValidAttachment(att) || !att.objectID) continue
    if (surviving.has(att.objectID)) continue
    orphanedObjectIDs.push(att.objectID)
  }

  return { manifest: updated, orphanedObjectIDs }
}

// Retract a single attachment from a published item — the file-level analog of
// deletePublishedItem. Rewrites the item with that attachment dropped (body and
// other attachments untouched, publishedAt preserved, editedAt stamped), then
// eagerly deletes the file's bytes unless something surviving still references
// them. Subscribers who pinned the post or the file keep their copies.
export async function removeAttachmentFromItem(
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  itemID: string,
  attachmentURL: string,
  protectedObjectIDs: ReadonlySet<string> = new Set(),
): Promise<{
  manifest: ChannelManifest
  item: ItemRef
  orphanedObjectIDs: string[]
}> {
  const did = agent.assertDid

  const current = await fetchChannel(did, channel.channelID, channel.channelKey)
  const index = current.items.findIndex((i) => i.id === itemID)
  if (index === -1) throw new Error('Item not found in channel')
  const item = current.items[index]
  const removed = (item.attachments ?? []).find(
    (a) => isValidAttachment(a) && a.url === attachmentURL,
  )

  const finalItem: ItemRef = {
    ...item,
    attachments: (item.attachments ?? []).filter(
      (a) => !(isValidAttachment(a) && a.url === attachmentURL),
    ),
    editedAt: new Date().toISOString(),
  }
  const updatedItems = [...current.items]
  updatedItems[index] = finalItem
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

  // Reference-safe prune: hand back the removed file's bytes unless another of
  // your posts / a library pin still references the same object. The caller
  // journals it as a delete-objects action.
  const surviving = survivingObjectIDs(updated, protectedObjectIDs)
  const orphanedObjectIDs: string[] = []
  if (
    removed &&
    isValidAttachment(removed) &&
    removed.objectID &&
    !surviving.has(removed.objectID)
  ) {
    orphanedObjectIDs.push(removed.objectID)
  }

  return { manifest: updated, item: finalItem, orphanedObjectIDs }
}

export async function editItem(
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  oldItemID: string,
  newItem: ItemRef,
  removedAttachmentObjectIDs?: string[],
): Promise<{
  manifest: ChannelManifest
  item: ItemRef
  orphanedObjectIDs: string[]
}> {
  const did = agent.assertDid

  const current = await fetchChannel(did, channel.channelID, channel.channelKey)
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

  // Hand back the old body + any removed-attachment bytes for the caller to
  // journal as a delete-objects action. Subscribers who pinned the old version
  // keep their snapshots (their copies live in their own scope).
  const orphanedObjectIDs = [oldItemID, ...(removedAttachmentObjectIDs ?? [])]

  return { manifest: updated, item: finalItem, orphanedObjectIDs }
}

export async function appendItemToChannel(
  agent: Agent,
  channel: { channelID: string; channelKey: string },
  itemRef: ItemRef,
): Promise<ChannelManifest> {
  const did = agent.assertDid

  const current = await fetchChannel(did, channel.channelID, channel.channelKey)

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
    throw new Error('Invalid subscribe URL (expected pin://<handle>#k=<key>)')
  }
  const [, authorHandle, channelKey] = m
  const keyBytes = channelKeyFromBase64(channelKey)
  const channelID = await deriveChannelID(keyBytes)
  return { authorHandle, channelID, channelKey }
}
