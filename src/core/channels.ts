import {
  channelKeyFromBase64,
  channelKeyToBase64,
  deriveChannelID,
  generateChannelKey,
} from './crypto'
import type { SiaClient } from './siaClient'
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
  client: SiaClient,
  img?: { bytes: Uint8Array; mimeType: string },
): Promise<ChannelImage | undefined> {
  if (!img) return undefined
  const uploaded = await client.uploadItem(img.bytes)
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
  // No subscribeURL — the did:dht form needs the author's identity key (pkarr
  // wasm, not available in core), so the caller builds it via lib/pkarr +
  // buildSubscribeURL.
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
  client: SiaClient,
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
    // The author's did:dht (derived by the caller from the AppKey — core stays
    // pure of the pkarr/wasm layer). Stamped into the manifest as the iroh-world
    // author identity.
    authorDidDht?: string
  },
): Promise<CreatedChannel> {
  const keyBytes = await generateChannelKey()
  const channelKey = channelKeyToBase64(keyBytes)
  const channelID = await deriveChannelID(keyBytes)

  const avatar = await uploadChannelImage(client, args.avatarImage)
  const cover = await uploadChannelImage(client, args.coverImage)

  const manifest: ChannelManifest = {
    version: CHANNEL_MANIFEST_VERSION,
    name: args.name,
    description: args.description,
    authorPubkey: client.appKeyPublicKey(),
    authorDidDht: args.authorDidDht,
    publishedAt: new Date().toISOString(),
    visibility: args.visibility ?? 'public',
    avatar,
    cover,
    items: [],
  }

  // No atproto write — the caller commits this manifest to the channel's pkarr
  // locator (Sia object + K-derived DHT pointer) via lib/channelWrites. Claim
  // ("Voices") is the local `advertised` flag on the OwnedChannel.
  return { channelID, channelKey, manifest }
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
  client: SiaClient,
  current: ChannelManifest,
  patch: EditChannelPatch,
): Promise<{ manifest: ChannelManifest; reclaimURLs: string[] }> {
  let avatar: ChannelImage | undefined = current.avatar
  if (patch.removeAvatar) {
    avatar = undefined
  } else if (patch.avatarImage) {
    avatar = await uploadChannelImage(client, patch.avatarImage)
  }

  let cover: ChannelImage | undefined = current.cover
  if (patch.removeCover) {
    cover = undefined
  } else if (patch.coverImage) {
    cover = await uploadChannelImage(client, patch.coverImage)
  }

  const updated: ChannelManifest = {
    ...current,
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    avatar,
    cover,
    publishedAt: new Date().toISOString(),
  }

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

// Enumerate a retracted channel's byte objects for reference-safe cleanup.
// Pure: takes the channel's current manifest (resolved by the caller via the
// locator, or null when it's already gone) and returns the object IDs (items +
// their attachment objects, reference-filtered) and image URLs (avatar/cover)
// the caller should journal as a delete-objects action. Dropping the channel's
// locator (Sia manifest object + pkarr pointer) is the caller's job too —
// there's no atproto record to delete anymore.
export function unpinChannel(
  current: ChannelManifest | null,
  // Object IDs referenced elsewhere in the author's own scope (other channel
  // manifests + pins) — survive the retract, same reference-safety as
  // deletePublishedItem. Defaults to empty.
  protectedObjectIDs: ReadonlySet<string> = new Set(),
): { objectIDs: string[]; urls: string[] } {
  const objectIDs: string[] = []
  const urls: string[] = []
  if (current) {
    for (const item of current.items) {
      if (!protectedObjectIDs.has(item.id)) objectIDs.push(item.id)
      for (const att of item.attachments ?? []) {
        if (!isValidAttachment(att) || !att.objectID) continue
        if (protectedObjectIDs.has(att.objectID)) continue
        objectIDs.push(att.objectID)
      }
    }
    for (const image of [current.avatar, current.cover]) {
      if (image) urls.push(image.itemURL)
    }
  }
  return { objectIDs, urls }
}

// All four below are PURE manifest transforms — they take the channel's current
// manifest and return the next one (+ reference-safe orphan enumeration). The
// caller reads `current` (from feedStore.manifests or the locator) and commits
// the returned manifest to the pkarr locator via lib/channelWrites. No atproto,
// no encryption here — encryption lives in the locator commit.

export function deletePublishedItem(
  current: ChannelManifest,
  itemID: string,
  // Object IDs referenced elsewhere in the author's own scope (other channel
  // manifests + pins). Bytes in this set survive the retract — a file shared
  // with another of your posts, or held by a standalone library pin, isn't
  // yanked out from under it. Defaults to empty; callers pass their in-memory
  // scope refs to make the reference-safe prune correct.
  protectedObjectIDs: ReadonlySet<string> = new Set(),
): { manifest: ChannelManifest; orphanedObjectIDs: string[] } {
  const removed = current.items.find((i) => i.id === itemID)

  const updated: ChannelManifest = {
    ...current,
    publishedAt: new Date().toISOString(),
    items: current.items.filter((i) => i.id !== itemID),
  }

  // Reference-safe prune: collect the body + every attachment whose bytes
  // nothing surviving still references, and hand them back. The caller journals
  // them as a durable, retried delete-objects action. Subscribers' pinned copies
  // live in their own scope, so this never touches them. (Legacy attachments
  // without an objectID can't be enumerated here; a known, bounded gap.)
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
// other attachments untouched, publishedAt preserved, editedAt stamped) and
// hands back the file's bytes for cleanup unless something surviving still
// references them. Subscribers who pinned the post or the file keep their copies.
export function removeAttachmentFromItem(
  current: ChannelManifest,
  itemID: string,
  attachmentURL: string,
  protectedObjectIDs: ReadonlySet<string> = new Set(),
): {
  manifest: ChannelManifest
  item: ItemRef
  orphanedObjectIDs: string[]
} {
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

export function editItem(
  current: ChannelManifest,
  oldItemID: string,
  newItem: ItemRef,
  removedAttachmentObjectIDs?: string[],
): {
  manifest: ChannelManifest
  item: ItemRef
  orphanedObjectIDs: string[]
} {
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

  // Hand back the old body + any removed-attachment bytes for the caller to
  // journal as a delete-objects action. Subscribers who pinned the old version
  // keep their snapshots (their copies live in their own scope).
  const orphanedObjectIDs = [oldItemID, ...(removedAttachmentObjectIDs ?? [])]

  return { manifest: updated, item: finalItem, orphanedObjectIDs }
}

export function appendItemToChannel(
  current: ChannelManifest,
  itemRef: ItemRef,
): ChannelManifest {
  return {
    ...current,
    publishedAt: new Date().toISOString(),
    items: [itemRef, ...current.items],
  }
}

export async function downloadItemBytes(
  client: SiaClient,
  itemURL: string,
): Promise<Uint8Array> {
  return client.downloadItem(itemURL)
}

// Phase D: the shared capability link carries the author's stable did:dht
// (`pin://<did:dht>#k=<K>`), not the atproto handle — the identity resolves without
// atproto, and non-unique self-asserted handles couldn't resolve globally anyway.
// The `author` slot is either a did:dht or (legacy) an atproto handle.
export function buildSubscribeURL(author: string, channelKey: string): string {
  return `pin://${author}#k=${channelKey}`
}

export async function parseSubscribeURL(url: string): Promise<{
  // Exactly one of these is set. did:dht form is the Phase D shape; the handle
  // form is still accepted so already-shared links (and the running app's stored
  // subs) keep working through the transition.
  authorHandle: string
  didDht?: string
  channelID: string
  channelKey: string
}> {
  const m = url.trim().match(/^pin:\/\/([^#/]+)#k=(.+)$/)
  if (!m) {
    throw new Error(
      'Invalid subscribe URL (expected pin://<did:dht|handle>#k=<key>)',
    )
  }
  const [, author, channelKey] = m
  const keyBytes = channelKeyFromBase64(channelKey)
  const channelID = await deriveChannelID(keyBytes)
  return author.startsWith('did:dht:')
    ? { authorHandle: '', didDht: author, channelID, channelKey }
    : { authorHandle: author, channelID, channelKey }
}
