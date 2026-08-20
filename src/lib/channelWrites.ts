// Phase D step 6: channel writes go through the pkarr locator, not atproto.
//
// core/channels.ts holds the PURE manifest transforms (append/edit/delete/…);
// this module orchestrates the write around them — read the channel's current
// manifest, apply the transform, and COMMIT the result to the locator (Sia
// object + K-derived DHT pointer), then reflect it in the feed store. The
// commit is awaited, so a write is "done" only once the bytes and the pointer
// are both live. This is where orchestration lives so core stays pure of the
// pkarr/wasm layer and components/actions stay thin.

import {
  appendItemToChannel,
  type CreatedChannel,
  createChannel,
  deletePublishedItem,
  type EditChannelPatch,
  editChannel,
  editItem,
  removeAttachmentFromItem,
  removeRepostFromChannel,
  repostToChannel,
  unpinChannel,
} from '../core/channels'
import type { SiaClient } from '../core/siaClient'
import type { ChannelManifest, ItemRef, RepostRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import {
  commitChannelManifest,
  forgetOwnManifest,
  resolveChannelViaLocator,
} from './channelLocator'
import {
  channelPublishKey,
  clearPublished,
  readPublished,
} from './publishState'
import type { PortalTarget } from './repost'

type Channel = { channelID: string; channelKey: string }

// The AppKey the publish-state records are sealed under. Read from the store rather
// than threaded through every caller: this module is already the layer that knows
// about stores (it reads the feed and the owner's subscription), and every write path
// through here runs connected — the callers gate on the client before arriving.
function appKey(): string {
  const hex = useAuthStore.getState().storedKeyHex
  if (!hex) throw new Error('Not connected to Sia')
  return hex
}

// Who to name in an endorsement's reference for one of this identity's own channels, or
// null for none. Public channels are navigable; an unlisted one publishes the subject
// hash alone, because a reference would give away both the channel and its existence.
function referenceAuthor(manifest: ChannelManifest): string | null {
  return manifest.visibility === 'public' && manifest.authorDidDht
    ? manifest.authorDidDht
    : null
}

// The author's own pin endorsement for one of their items.
//
// Publishing already put the bytes in this identity's Sia scope, so the author IS pin
// #1: a fresh post reads 1 rather than 0, because exactly one party is paying to keep it
// alive. Every pin after that is another party who would keep it alive if the author
// retracted — which is what makes the number a redundancy count rather than a popularity
// one, and why it starts at 1.
//
// Best-effort, and after the commit rather than inside it. The publish is already done —
// bytes and pointer both live — so a doc write that fails costs a count, never the post.
// The catch-up in `usePinDocsMirror` is not this one's backstop, so an author's own
// endorsement is retried by the next commit touching the same item.
async function endorseOwn(
  channelID: string,
  manifest: ChannelManifest,
  item: ItemRef,
) {
  try {
    const { writeEndorsement } = await import('./engagement')
    await writeEndorsement(
      appKey(),
      'pin',
      {
        channelID,
        publishedAt: item.publishedAt,
        contentHash: item.contentHash,
      },
      referenceAuthor(manifest),
    )
  } catch (e) {
    console.warn('own endorsement write failed:', e)
  }
}

// Withdraw the author's own endorsements for items that are gone.
//
// The count then falls to whoever is still paying — a post at 2 that its author retracts
// becomes 1, and it survives BECAUSE of that 1. That is the custody model stated as a
// number: a subscriber's pinned copy is independent of the author's manifest.
async function unendorseOwn(channelID: string, publishedAt: readonly string[]) {
  if (publishedAt.length === 0) return
  try {
    const { deleteEndorsement } = await import('./engagement')
    for (const at of publishedAt) {
      await deleteEndorsement(appKey(), 'pin', { channelID, publishedAt: at })
    }
  } catch (e) {
    console.warn('own endorsement release failed (will retry):', e)
  }
}

// The channel's current manifest: the author's local copy (feedStore) is
// authoritative for single-device authoring and avoids a DHT round-trip; fall
// back to resolving the locator when it's not cached (cold start / new device).
async function loadCurrentManifest(channel: Channel): Promise<ChannelManifest> {
  const cached = useFeedStore.getState().manifests[channel.channelID]
  if (cached) return cached
  const resolved = await resolveChannelViaLocator(channel.channelKey)
  if (!resolved) {
    throw new Error(`Channel ${channel.channelID} not found (no locator)`)
  }
  return resolved
}

// Reflect a freshly-committed manifest in the feed store without a re-read:
// rebuild its entries from the manifest in hand (via the owner's own
// subscription, which carries the display identity), or just cache the manifest
// when there's no subscription for it.
function reflectInFeed(channelID: string, manifest: ChannelManifest): void {
  const feed = useFeedStore.getState()
  const sub = useAuthStore
    .getState()
    .subscriptions.find((s) => s.channelID === channelID)
  if (sub) feed.applyManifest(sub, manifest)
  else feed.setManifest(channelID, manifest)
}

export async function createAndPublishChannel(
  client: SiaClient,
  args: Parameters<typeof createChannel>[1],
): Promise<CreatedChannel> {
  const created = await createChannel(client, args)
  await commitChannelManifest(
    client,
    appKey(),
    created.channelID,
    created.channelKey,
    created.manifest,
  )
  useFeedStore.getState().setManifest(created.channelID, created.manifest)
  return created
}

export async function saveChannelEdits(
  client: SiaClient,
  channel: Channel,
  patch: EditChannelPatch,
): Promise<{ manifest: ChannelManifest; reclaimURLs: string[] }> {
  const current = await loadCurrentManifest(channel)
  const { manifest, reclaimURLs } = await editChannel(client, current, patch)
  await commitChannelManifest(
    client,
    appKey(),
    channel.channelID,
    channel.channelKey,
    manifest,
  )
  reflectInFeed(channel.channelID, manifest)
  return { manifest, reclaimURLs }
}

export async function publishItemToChannel(
  client: SiaClient,
  channel: Channel,
  itemRef: ItemRef,
): Promise<ChannelManifest> {
  const current = await loadCurrentManifest(channel)
  const manifest = await appendItemToChannel(current, itemRef)
  await commitChannelManifest(
    client,
    appKey(),
    channel.channelID,
    channel.channelKey,
    manifest,
  )
  reflectInFeed(channel.channelID, manifest)
  await endorseOwn(channel.channelID, manifest, itemRef)
  return manifest
}

export async function editPublishedItem(
  client: SiaClient,
  channel: Channel,
  oldItemID: string,
  newItem: ItemRef,
  removedAttachmentObjectIDs?: string[],
): Promise<{
  manifest: ChannelManifest
  item: ItemRef
  orphanedObjectIDs: string[]
}> {
  const current = await loadCurrentManifest(channel)
  const result = await editItem(
    current,
    oldItemID,
    newItem,
    removedAttachmentObjectIDs,
  )
  await commitChannelManifest(
    client,
    appKey(),
    channel.channelID,
    channel.channelKey,
    result.manifest,
  )
  reflectInFeed(channel.channelID, result.manifest)
  // An edit keeps the item's `publishedAt`, so the endorsement's subject is unchanged and
  // the same record is rewritten with the version it now stands against.
  await endorseOwn(channel.channelID, result.manifest, result.item)
  return result
}

export async function deleteItemFromChannel(
  client: SiaClient,
  channel: Channel,
  itemID: string,
  protectedObjectIDs?: ReadonlySet<string>,
): Promise<{ manifest: ChannelManifest; orphanedObjectIDs: string[] }> {
  const current = await loadCurrentManifest(channel)
  // Read before the transform: the subject is derived from `publishedAt`, which is only
  // available while the item is still in the manifest.
  const retracted = current.items.find((i) => i.id === itemID)?.publishedAt
  const result = await deletePublishedItem(current, itemID, protectedObjectIDs)
  await commitChannelManifest(
    client,
    appKey(),
    channel.channelID,
    channel.channelKey,
    result.manifest,
  )
  reflectInFeed(channel.channelID, result.manifest)
  await unendorseOwn(channel.channelID, retracted ? [retracted] : [])
  return result
}

export async function removeAttachment(
  client: SiaClient,
  channel: Channel,
  itemID: string,
  attachmentURL: string,
  protectedObjectIDs?: ReadonlySet<string>,
): Promise<{
  manifest: ChannelManifest
  item: ItemRef
  orphanedObjectIDs: string[]
}> {
  const current = await loadCurrentManifest(channel)
  const result = await removeAttachmentFromItem(
    current,
    itemID,
    attachmentURL,
    protectedObjectIDs,
  )
  await commitChannelManifest(
    client,
    appKey(),
    channel.channelID,
    channel.channelKey,
    result.manifest,
  )
  reflectInFeed(channel.channelID, result.manifest)
  return result
}

// Circulate somebody else's post in one of this identity's channels.
//
// Awaited to the same bar as any other channel write: when this resolves, the Sia object
// and the DHT pointer are both live and a subscriber can read it. A repost is a publish,
// and the gesture that makes one is entitled to fail visibly rather than to look like it
// worked.
//
// No bytes move. The portal is an address, and the post it names stays where its author
// put it — which is what lets their edit show through, their retraction show through as a
// gap, and their un-advertising take it back down.
export async function repostInChannel(
  client: SiaClient,
  channel: Channel,
  repost: RepostRef,
): Promise<ChannelManifest> {
  const current = await loadCurrentManifest(channel)
  const manifest = await repostToChannel(current, repost)
  await commitChannelManifest(
    client,
    appKey(),
    channel.channelID,
    channel.channelKey,
    manifest,
  )
  reflectInFeed(channel.channelID, manifest)
  return manifest
}

// Stop circulating a post here. Nothing to reclaim — a portal never held bytes, so unlike
// every other removal on a channel this frees nothing and journals nothing.
export async function unrepostFromChannel(
  client: SiaClient,
  channel: Channel,
  target: PortalTarget,
): Promise<ChannelManifest> {
  const current = await loadCurrentManifest(channel)
  const manifest = await removeRepostFromChannel(current, target)
  await commitChannelManifest(
    client,
    appKey(),
    channel.channelID,
    channel.channelKey,
    manifest,
  )
  reflectInFeed(channel.channelID, manifest)
  return manifest
}

// Retract a whole channel. Idempotent: if the locator can't be resolved (already
// gone / never published) we enumerate nothing and still clear local state — the
// goal ("this channel is gone") is met. Returns the byte objects for the caller
// to journal as a durable delete-objects action; the channel's own Sia manifest
// object (the locator target) is included, and its pkarr record expires by TTL
// once we stop republishing it.
export async function retractChannel(
  channel: Channel,
  protectedObjectIDs?: ReadonlySet<string>,
): Promise<{ objectIDs: string[]; urls: string[] }> {
  let current: ChannelManifest | null = null
  try {
    current = await loadCurrentManifest(channel)
  } catch {
    // Locator unresolvable — treat as already gone; enumerate nothing.
  }

  const { objectIDs, urls } = await unpinChannel(current, protectedObjectIDs)

  // The Sia objects holding the manifest generations (current + the kept grace
  // generation) are orphans on retract — include both so the journaled cleanup
  // reclaims them.
  const rkey = await channelPublishKey(channel.channelID)
  const manifestObject = await readPublished(appKey(), rkey)
  for (const id of [manifestObject?.id, manifestObject?.olderId]) {
    if (id && !protectedObjectIDs?.has(id)) objectIDs.push(id)
  }
  await clearPublished(appKey(), rkey)
  // And the doc's copy of the manifest, so the record doesn't outlive its channel.
  await forgetOwnManifest(appKey(), channel.channelID)
  // Every item's endorsement goes with it. Each count falls to the subscribers still
  // holding a copy, which is exactly who is keeping it alive now.
  await unendorseOwn(
    channel.channelID,
    (current?.items ?? []).map((i) => i.publishedAt),
  )

  useFeedStore.getState().removeChannel(channel.channelID)
  return { objectIDs, urls }
}
