import {
  manifest_add_repost,
  manifest_append_item,
  manifest_build_item,
  manifest_create_channel,
  manifest_delete_item,
  manifest_edit_channel,
  manifest_edit_item,
  manifest_enumerate_retract,
  manifest_remove_attachment,
  manifest_remove_repost,
} from '../../crates/pin-core/pkg/pin_core.js'
import {
  channelKeyFromBase64,
  channelKeyToBase64,
  deriveChannelID,
  generateChannelKey,
} from './crypto'
import type { SiaClient } from './siaClient'
import type {
  AttachmentRef,
  ChannelImage,
  ChannelManifest,
  ChannelVisibility,
  Facet,
  ItemRef,
  ItemType,
  PortalAddress,
  RepostRef,
} from './types'
import { ensureWasm } from './wasm'

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
    // Whether the channel takes comments. Absent means the default a new channel
    // gets, which is on — one created now is created in a product that has them.
    comments?: boolean
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

  // Store the images first, then build. Storing needs the Sia client — which is the
  // platform-correct one already — so it stays here; the manifest itself is built by
  // pin_manifest, the same code the Curator builds one with.
  const avatar = await uploadChannelImage(client, args.avatarImage)
  const cover = await uploadChannelImage(client, args.coverImage)

  await ensureWasm()
  const manifest: ChannelManifest = JSON.parse(
    manifest_create_channel(
      JSON.stringify({
        name: args.name,
        description: args.description,
        visibility: args.visibility,
        comments: args.comments,
        authorPubkey: client.appKeyPublicKey(),
        authorDidDht: args.authorDidDht,
        avatar,
        cover,
      }),
      stamp(),
    ),
  )

  // No atproto write — the caller commits this manifest to the channel's pkarr
  // locator (Sia object + K-derived DHT pointer) via lib/channelWrites. Claim
  // ("Voices") is the local `advertised` flag on the OwnedChannel.
  return { channelID, channelKey, manifest }
}

export type EditChannelPatch = {
  name?: string
  description?: string
  // Absent leaves it as it stands, like every other field here.
  comments?: boolean
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
  // Store any replacement images first — that's the part that needs the Sia client —
  // then let pin_manifest settle which image survives and which bytes the edit
  // orphaned. Those orphans are why the caller gets `reclaimURLs` back: per-object Sia
  // encryption gives every upload its own object, so an old avatar is never shared with
  // anything else and can be journaled for cleanup without a refcount check.
  const avatar = patch.removeAvatar
    ? undefined
    : await uploadChannelImage(client, patch.avatarImage)
  const cover = patch.removeCover
    ? undefined
    : await uploadChannelImage(client, patch.coverImage)

  await ensureWasm()
  const { manifest, reclaimURLs } = JSON.parse(
    manifest_edit_channel(
      JSON.stringify(current),
      JSON.stringify({
        name: patch.name,
        description: patch.description,
        comments: patch.comments,
        avatar,
        cover,
        removeAvatar: patch.removeAvatar ?? false,
        removeCover: patch.removeCover ?? false,
      }),
      stamp(),
    ),
  )
  return { manifest, reclaimURLs }
}

// --- manifest transforms -------------------------------------------------------
//
// Bindings now, not implementations. The rules for changing a channel live in
// `pin_manifest` and are reached through pin-core, because the Curator applies the
// same rules when it publishes or repacks with no UI open — and because these are what
// decide which bytes get DELETED, so two implementations disagreeing wouldn't be
// untidy, it would drop bytes something still points at.
//
// Each hands the clock across explicitly: SystemTime::now() panics on wasm32, and the
// timestamp has to be the one JavaScript would have written, since a manifest's
// publishedAt is compared as a string to tell a newer copy from an older one.
//
// Manifests cross as JSON — the shape they already travel in everywhere else (sealed
// under K on Sia, cached in the doc), so nothing here invents a second encoding.

const stamp = () => new Date().toISOString()
const idList = (set: ReadonlySet<string>) => [...set]

export async function buildItemRef(
  uploaded: {
    id: string
    itemURL: string
    byteSize: number
    contentHash: string
  },
  payload: ItemPayload,
): Promise<ItemRef> {
  await ensureWasm()
  // Only the fields that reach the manifest — deliberately NOT the whole payload,
  // which also carries the body bytes and the unresolved attachment sources. A
  // Uint8Array serializes as a numbered object, so handing the payload over wholesale
  // would marshal the entire upload through JSON for fields nobody reads.
  const draft = {
    type: payload.type,
    title: payload.title,
    summary: payload.summary,
    mimeType: payload.mimeType,
    durationMs: payload.durationMs,
    filename: payload.filename,
    attachments: payload.attachments,
    facets: payload.facets,
  }
  return JSON.parse(
    manifest_build_item(
      JSON.stringify(uploaded),
      JSON.stringify(draft),
      stamp(),
    ),
  )
}

// Enumerate a retracted channel's byte objects for reference-safe cleanup. Takes the
// channel's current manifest (resolved by the caller via the locator, or null when
// it's already gone — a retract whose target has vanished enumerates nothing and still
// succeeds) and returns the object IDs and the avatar/cover URLs the caller should
// journal as a delete-objects action. Dropping the channel's locator is the caller's
// job too.
export async function unpinChannel(
  current: ChannelManifest | null,
  // Object IDs referenced elsewhere in the author's own scope (other channel
  // manifests + pins) — these survive the retract.
  protectedObjectIDs: ReadonlySet<string> = new Set(),
): Promise<{ objectIDs: string[]; urls: string[] }> {
  await ensureWasm()
  return JSON.parse(
    manifest_enumerate_retract(
      current ? JSON.stringify(current) : '',
      idList(protectedObjectIDs),
    ),
  )
}

export async function deletePublishedItem(
  current: ChannelManifest,
  itemID: string,
  // Bytes in this set survive the retract — a file shared with another of your posts,
  // or held by a standalone library pin, isn't yanked out from under it. Callers pass
  // their in-memory scope refs to make the reference-safe prune correct.
  protectedObjectIDs: ReadonlySet<string> = new Set(),
): Promise<{ manifest: ChannelManifest; orphanedObjectIDs: string[] }> {
  await ensureWasm()
  return JSON.parse(
    manifest_delete_item(
      JSON.stringify(current),
      itemID,
      idList(protectedObjectIDs),
      stamp(),
    ),
  )
}

// Retract a single attachment from a published item — the file-level analog of
// deletePublishedItem. The body and the other attachments are untouched and the item
// keeps its place in the channel's chronology; editedAt records the drift. Subscribers
// who pinned the post or the file keep their copies.
export async function removeAttachmentFromItem(
  current: ChannelManifest,
  itemID: string,
  attachmentURL: string,
  protectedObjectIDs: ReadonlySet<string> = new Set(),
): Promise<{
  manifest: ChannelManifest
  item: ItemRef
  orphanedObjectIDs: string[]
}> {
  await ensureWasm()
  return JSON.parse(
    manifest_remove_attachment(
      JSON.stringify(current),
      itemID,
      attachmentURL,
      idList(protectedObjectIDs),
      stamp(),
    ),
  )
}

export async function editItem(
  current: ChannelManifest,
  oldItemID: string,
  newItem: ItemRef,
  removedAttachmentObjectIDs?: string[],
): Promise<{
  manifest: ChannelManifest
  item: ItemRef
  orphanedObjectIDs: string[]
}> {
  await ensureWasm()
  return JSON.parse(
    manifest_edit_item(
      JSON.stringify(current),
      oldItemID,
      JSON.stringify(newItem),
      removedAttachmentObjectIDs ?? [],
      stamp(),
    ),
  )
}

export async function appendItemToChannel(
  current: ChannelManifest,
  itemRef: ItemRef,
): Promise<ChannelManifest> {
  await ensureWasm()
  return JSON.parse(
    manifest_append_item(
      JSON.stringify(current),
      JSON.stringify(itemRef),
      stamp(),
    ),
  )
}

// Circulate somebody else's post in one of this identity's channels, as a portal to
// it rather than a copy of it. `repostedAt` is what the portal sorts by here, so the
// caller stamps it — the same split as appendItemToChannel, which takes an item that
// already knows when it was published.
export async function repostToChannel(
  current: ChannelManifest,
  repost: RepostRef,
): Promise<ChannelManifest> {
  await ensureWasm()
  return JSON.parse(
    manifest_add_repost(
      JSON.stringify(current),
      JSON.stringify(repost),
      stamp(),
    ),
  )
}

// Stop circulating a post here. Nothing to reclaim — a portal never held bytes, which
// is why this returns a manifest rather than the orphan list every other removal does.
export async function removeRepostFromChannel(
  current: ChannelManifest,
  target: PortalAddress,
): Promise<ChannelManifest> {
  await ensureWasm()
  return JSON.parse(
    manifest_remove_repost(
      JSON.stringify(current),
      JSON.stringify(target),
      stamp(),
    ),
  )
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
