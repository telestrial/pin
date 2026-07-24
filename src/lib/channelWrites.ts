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
  unpinChannel,
} from '../core/channels'
import type { SiaClient } from '../core/siaClient'
import type { ChannelManifest, ItemRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import {
  clearLocatorObjectPointer,
  commitChannelManifest,
  readLocatorObjectPointer,
  resolveChannelViaLocator,
} from './channelLocator'

type Channel = { channelID: string; channelKey: string }

// The channel's current manifest: the author's local copy (feedStore) is
// authoritative for single-device authoring and avoids a DHT round-trip; fall
// back to resolving the locator when it's not cached (cold start / new device).
async function loadCurrentManifest(
  client: SiaClient,
  channel: Channel,
): Promise<ChannelManifest> {
  const cached = useFeedStore.getState().manifests[channel.channelID]
  if (cached) return cached
  const resolved = await resolveChannelViaLocator(client, channel.channelKey)
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
  const current = await loadCurrentManifest(client, channel)
  const { manifest, reclaimURLs } = await editChannel(client, current, patch)
  await commitChannelManifest(
    client,
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
  const current = await loadCurrentManifest(client, channel)
  const manifest = appendItemToChannel(current, itemRef)
  await commitChannelManifest(
    client,
    channel.channelID,
    channel.channelKey,
    manifest,
  )
  reflectInFeed(channel.channelID, manifest)
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
  const current = await loadCurrentManifest(client, channel)
  const result = editItem(
    current,
    oldItemID,
    newItem,
    removedAttachmentObjectIDs,
  )
  await commitChannelManifest(
    client,
    channel.channelID,
    channel.channelKey,
    result.manifest,
  )
  reflectInFeed(channel.channelID, result.manifest)
  return result
}

export async function deleteItemFromChannel(
  client: SiaClient,
  channel: Channel,
  itemID: string,
  protectedObjectIDs?: ReadonlySet<string>,
): Promise<{ manifest: ChannelManifest; orphanedObjectIDs: string[] }> {
  const current = await loadCurrentManifest(client, channel)
  const result = deletePublishedItem(current, itemID, protectedObjectIDs)
  await commitChannelManifest(
    client,
    channel.channelID,
    channel.channelKey,
    result.manifest,
  )
  reflectInFeed(channel.channelID, result.manifest)
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
  const current = await loadCurrentManifest(client, channel)
  const result = removeAttachmentFromItem(
    current,
    itemID,
    attachmentURL,
    protectedObjectIDs,
  )
  await commitChannelManifest(
    client,
    channel.channelID,
    channel.channelKey,
    result.manifest,
  )
  reflectInFeed(channel.channelID, result.manifest)
  return result
}

// Retract a whole channel. Idempotent: if the locator can't be resolved (already
// gone / never published) we enumerate nothing and still clear local state — the
// goal ("this channel is gone") is met. Returns the byte objects for the caller
// to journal as a durable delete-objects action; the channel's own Sia manifest
// object (the locator target) is included, and its pkarr record expires by TTL
// once we stop republishing it.
export async function retractChannel(
  client: SiaClient,
  channel: Channel,
  protectedObjectIDs?: ReadonlySet<string>,
): Promise<{ objectIDs: string[]; urls: string[] }> {
  let current: ChannelManifest | null = null
  try {
    current = await loadCurrentManifest(client, channel)
  } catch {
    // Locator unresolvable — treat as already gone; enumerate nothing.
  }

  const { objectIDs, urls } = unpinChannel(current, protectedObjectIDs)

  // The Sia objects holding the manifest generations (current + the kept grace
  // generation) are orphans on retract — include both so the journaled cleanup
  // reclaims them.
  const manifestObject = readLocatorObjectPointer(channel.channelID)
  for (const id of [manifestObject?.id, manifestObject?.olderId]) {
    if (id && !protectedObjectIDs?.has(id)) objectIDs.push(id)
  }
  clearLocatorObjectPointer(channel.channelID)

  useFeedStore.getState().removeChannel(channel.channelID)
  return { objectIDs, urls }
}
