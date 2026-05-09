import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { putChannelRecord } from './atproto'
import { fetchChannel } from './channels'
import { channelKeyFromBase64, encryptForChannel } from './crypto'
import { downloadItem, uploadItemsPacked } from './sia'
import type { ChannelManifest } from './types'

// 10 data shards × 4 MiB each = 40 MiB usable per slab. Same constant
// useUploadRunner uses for shard-count math.
const SLAB_DATA_BYTES = 10 * 4 * 1024 * 1024

// Pack to ~95% of slab capacity to leave a hair of headroom and avoid
// edge-case overflow into a second slab.
const SLAB_PACK_TARGET_BYTES = SLAB_DATA_BYTES * 0.95

// Don't bother repacking unless we can collapse at least this many slabs
// into one. Reclaim per batch ≈ (count − 1) × 40 MiB.
const MIN_BATCH_SLABS = 3

// Ignore slabs that are already mostly full — marginal gain, lots of work.
const FULL_THRESHOLD = 0.8

// Skip slabs whose newest object was created within this window — the user
// might still be in a publishing burst and we don't want to churn mid-stream.
const MIN_SLAB_AGE_MS = 2 * 60 * 1000

export type ScopeRef =
  | {
      source: 'channel'
      objectID: string
      itemURL: string
      channelID: string
      channelKey: string
    }
  | {
      source: 'library'
      objectID: string
      itemURL: string
    }
  | {
      source: 'external'
      objectID: string
      itemURL: string
    }

type SlabAggregate = {
  encryptionKey: string
  bytesUsed: number
  capacity: number
  objects: Array<{ id: string; length: number; createdAt: Date }>
}

export type RepackBatchResult = {
  reclaimedSlabs: number
  oldObjectIDs: string[]
  pinStoreReplacements: Array<{
    oldObjectID: string
    newObjectID: string
    newURL: string
    newContentHash: string
  }>
  affectedChannelIDs: string[]
}

async function buildSlabAggregates(
  sdk: Sdk,
  scope: ScopeRef[],
): Promise<{ slabs: SlabAggregate[]; refsByID: Map<string, ScopeRef> }> {
  const groups = new Map<string, SlabAggregate>()
  const refsByID = new Map(scope.map((r) => [r.objectID, r]))

  await Promise.all(
    scope.map(async (ref) => {
      try {
        const obj = await sdk.object(ref.objectID)
        const objSlabs = obj.slabs()
        const createdAt = obj.createdAt()
        for (const s of objSlabs) {
          let g = groups.get(s.encryptionKey)
          if (!g) {
            g = {
              encryptionKey: s.encryptionKey,
              bytesUsed: 0,
              capacity: s.minShards * (4 * 1024 * 1024),
              objects: [],
            }
            groups.set(s.encryptionKey, g)
          }
          g.bytesUsed += s.length
          g.objects.push({ id: ref.objectID, length: s.length, createdAt })
        }
      } catch (e) {
        // Best-effort: a single failed sdk.object lookup shouldn't poison
        // the whole pass. We just won't consider that object's slab.
        console.warn(`repack: failed to inspect object ${ref.objectID}:`, e)
      }
    }),
  )

  return { slabs: Array.from(groups.values()), refsByID }
}

function pickBatch(slabs: SlabAggregate[], now = Date.now()): SlabAggregate[] {
  const eligible = slabs.filter((s) => {
    if (s.bytesUsed / s.capacity > FULL_THRESHOLD) return false
    if (s.objects.length === 0) return false
    const newest = Math.max(...s.objects.map((o) => o.createdAt.getTime()))
    if (now - newest < MIN_SLAB_AGE_MS) return false
    return true
  })

  if (eligible.length < MIN_BATCH_SLABS) return []

  // Greedy bin-pack: smallest-bytesUsed first, fill until next slab won't fit.
  eligible.sort((a, b) => a.bytesUsed - b.bytesUsed)

  const batch: SlabAggregate[] = []
  let total = 0
  for (const s of eligible) {
    if (total + s.bytesUsed > SLAB_PACK_TARGET_BYTES) break
    batch.push(s)
    total += s.bytesUsed
  }

  return batch.length >= MIN_BATCH_SLABS ? batch : []
}

export async function runRepackBatch(
  sdk: Sdk,
  agent: Agent | null,
  scope: ScopeRef[],
): Promise<RepackBatchResult | null> {
  const { slabs, refsByID } = await buildSlabAggregates(sdk, scope)
  const batch = pickBatch(slabs)
  if (batch.length === 0) return null

  // Resolve every object in the batch to its ScopeRef.
  const refs: ScopeRef[] = []
  for (const slab of batch) {
    for (const o of slab.objects) {
      const r = refsByID.get(o.id)
      if (r) refs.push(r)
    }
  }
  if (refs.length === 0) return null

  // If any object lives in an own channel, we need an agent to rewrite that
  // channel's manifest. Without one, drop channel objects from this batch
  // and only pack library + external. Keeps Just-Reading users productive.
  const filteredRefs = agent
    ? refs
    : refs.filter((r) => r.source !== 'channel')
  if (filteredRefs.length === 0) return null

  // Download bytes for each — uses the existing useItemBytes cache path
  // by going through downloadItem (sharedObject + download stream).
  const allBytes = await Promise.all(
    filteredRefs.map((r) => downloadItem(sdk, r.itemURL)),
  )

  // Pack into a freshly-allocated slab.
  const uploaded = await uploadItemsPacked(sdk, allBytes)

  // Build mapping: old object → new object.
  type Mapping = {
    oldRef: ScopeRef
    newID: string
    newURL: string
    newContentHash: string
  }
  const mappings: Mapping[] = filteredRefs.map((r, i) => ({
    oldRef: r,
    newID: uploaded[i].id,
    newURL: uploaded[i].itemURL,
    newContentHash: uploaded[i].contentHash,
  }))

  // Manifest swaps, grouped by channel so each channel's manifest is
  // rewritten exactly once per batch (saves putRecord calls + JetStream
  // commit churn).
  const channelGroups = new Map<string, Mapping[]>()
  for (const m of mappings) {
    if (m.oldRef.source !== 'channel') continue
    const arr = channelGroups.get(m.oldRef.channelID) ?? []
    arr.push(m)
    channelGroups.set(m.oldRef.channelID, arr)
  }

  const affectedChannelIDs: string[] = []
  for (const [channelID, channelMappings] of channelGroups) {
    if (!agent) continue // shouldn't reach here per filter above
    const channelKey = (channelMappings[0].oldRef as Extract<
      ScopeRef,
      { source: 'channel' }
    >).channelKey
    const did = agent.assertDid

    const manifest = await fetchChannel(did, channelID, channelKey)

    const replacementsByURL = new Map<
      string,
      { url: string; id: string; contentHash: string }
    >()
    for (const m of channelMappings) {
      replacementsByURL.set(m.oldRef.itemURL, {
        url: m.newURL,
        id: m.newID,
        contentHash: m.newContentHash,
      })
    }

    // Rewrite item entries in place, preserving each item's publishedAt.
    // Repack is housekeeping, not republish — chronology stays put.
    // contentHash is computed from plaintext bytes so it equals the
    // existing hash for already-tagged items; legacy items without a
    // hash get one backfilled here as a free side effect of repack.
    const updatedItems = manifest.items.map((item) => {
      const r = replacementsByURL.get(item.itemURL)
      if (!r) return item
      return {
        ...item,
        id: r.id,
        itemURL: r.url,
        contentHash: r.contentHash,
      }
    })

    let coverArt = manifest.coverArt
    if (coverArt) {
      const r = replacementsByURL.get(coverArt.itemURL)
      if (r) {
        coverArt = {
          ...coverArt,
          itemURL: r.url,
          contentHash: r.contentHash,
        }
      }
    }

    const updated: ChannelManifest = {
      ...manifest,
      // Manifest's own publishedAt is bumped — the manifest record itself
      // is genuinely new. Items' publishedAt stays. Subscribers will see a
      // JetStream commit and refresh; the visible chronological order is
      // unchanged because items kept their timestamps.
      publishedAt: new Date().toISOString(),
      coverArt,
      items: updatedItems,
    }

    const keyBytes = channelKeyFromBase64(channelKey)
    const ciphertext = await encryptForChannel(
      keyBytes,
      JSON.stringify(updated),
    )
    await putChannelRecord(agent, channelID, ciphertext)
    affectedChannelIDs.push(channelID)
  }

  // Swap mappings for non-channel sources go back to the pinStore via
  // the runner — return them, don't touch the store from core/.
  const pinStoreReplacements = mappings
    .filter((m) => m.oldRef.source !== 'channel')
    .map((m) => ({
      oldObjectID: m.oldRef.objectID,
      newObjectID: m.newID,
      newURL: m.newURL,
      newContentHash: m.newContentHash,
    }))

  // Delete old bytes. Subscribers who pinned own-channel items keep their
  // own copies (separate scope); deleting from our scope only touches our
  // pin record.
  const oldObjectIDs = mappings.map((m) => m.oldRef.objectID)
  for (const id of oldObjectIDs) {
    try {
      await sdk.deleteObject(id)
    } catch (e) {
      console.warn(`repack: failed to delete old object ${id}:`, e)
    }
  }

  // The indexer doesn't auto-drop empty slabs — without this call, every
  // batch is a net +40 MiB (new packed slab) instead of the intended
  // −(N−1) × 40 MiB reclaim. pruneSlabs releases all slabs in our scope
  // that no live object references.
  try {
    await sdk.pruneSlabs()
  } catch (e) {
    console.warn('repack: pruneSlabs failed:', e)
  }

  return {
    reclaimedSlabs: batch.length,
    oldObjectIDs,
    pinStoreReplacements,
    affectedChannelIDs,
  }
}
