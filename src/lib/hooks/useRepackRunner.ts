import type { Sdk } from '@siafoundation/sia-storage'
import { useEffect } from 'react'
import { resolveChannelImageIDs } from '../../core/channelImages'
import {
  type ChannelManifestIO,
  runRepackBatch,
  type ScopeRef,
} from '../../core/repack'
import { isValidAttachment } from '../../core/types'
import { checkpointedObjectIDs, useActionStore } from '../../stores/actionQueue'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { usePinStore } from '../../stores/pin'
import { useStorageActivityStore } from '../../stores/storageActivity'
import { useToastStore } from '../../stores/toast'
import {
  commitChannelManifest,
  resolveChannelViaLocator,
} from '../channelLocator'
import { LIBRARY_CHANNEL } from '../pinUpload'

// Build the "what's pinned in your scope right now" snapshot the repack
// core needs to evaluate slabs. Own-channel items come from feedStore
// (they have IDs from publish), library + external pins come from
// pinStore. Subscribed-but-not-pinned items in feedStore aren't in your
// scope and don't appear here.
//
// Cover art lives outside manifest.items in the manifest itself, so it
// has to be resolved via sharedObject(url) → id() — the manifest doesn't
// store the cover's object ID directly. Without this step, cover-art
// slabs are invisible to the repacker and stay in their own dedicated
// 40 MiB slabs forever.
async function buildScope(sdk: Sdk): Promise<ScopeRef[]> {
  const auth = useAuthStore.getState()
  const feed = useFeedStore.getState()
  const pin = usePinStore.getState()

  const scope: ScopeRef[] = []
  // Dedup by objectID across every source — an attachment may also be
  // in pinStore as a library entry (same bytes, same Sia object), and
  // we never want to feed the same object into uploadItemsPacked twice.
  //
  // Pre-seed with the object IDs of any checkpointed upload task: those bytes
  // are still pin/publish-pending (or a failed task awaiting retry), and the
  // task's checkpoint holds their current URL. If repack moved them, the
  // resume would append/pin a stale URL. Treating them as already-seen keeps
  // them out of every batch until their task completes (then they leave the
  // queue and become repack-eligible normally).
  const seenIDs = checkpointedObjectIDs(useActionStore.getState().actions)
  const push = (ref: ScopeRef) => {
    if (seenIDs.has(ref.objectID)) return
    seenIDs.add(ref.objectID)
    scope.push(ref)
  }

  const myChannelIDSet = new Set(auth.myChannels.map((c) => c.channelID))
  const channelKeyByID = new Map(
    auth.myChannels.map((c) => [c.channelID, c.channelKey]),
  )

  // Channel item bodies + attachments (when attachment.objectID is
  // stored from upload time). Legacy attachments without a stored
  // objectID will pick one up on their next sweep / repack pass via
  // sharedObject; we'd rather skip them this pass than pay N
  // round-trips per scope build (this fires on every pin event).
  for (const entry of feed.entries) {
    if (!myChannelIDSet.has(entry.channel.channelID)) continue
    const channelKey = channelKeyByID.get(entry.channel.channelID)
    if (!channelKey) continue
    if (entry.item.id && entry.item.itemURL) {
      push({
        source: 'channel',
        objectID: entry.item.id,
        itemURL: entry.item.itemURL,
        channelID: entry.channel.channelID,
        channelKey,
      })
    }
    if (entry.item.attachments) {
      for (const att of entry.item.attachments) {
        if (!isValidAttachment(att)) continue
        if (!att.objectID) continue
        push({
          source: 'channel',
          objectID: att.objectID,
          itemURL: att.url,
          channelID: entry.channel.channelID,
          channelKey,
        })
      }
    }
  }

  // Channel images (avatar + cover) per owned channel — resolution failures
  // are best-effort, missing images just don't get repacked this pass.
  const images = await resolveChannelImageIDs(
    sdk,
    auth.myChannels,
    feed.manifests,
  )
  for (const f of images.failed) {
    console.warn(
      `repack: failed to resolve ${f.kind} for ${f.channelID}:`,
      f.error,
    )
  }
  for (const img of images.resolved) {
    const channelKey = channelKeyByID.get(img.channelID)
    if (!channelKey) continue
    push({
      source: 'channel',
      objectID: img.objectID,
      itemURL: img.itemURL,
      channelID: img.channelID,
      channelKey,
    })
  }

  for (const p of pin.pinned) {
    if (!p.objectID) continue
    if (myChannelIDSet.has(p.channel.channelID)) continue
    if (p.channel.channelID === LIBRARY_CHANNEL.channelID) {
      push({
        source: 'library',
        objectID: p.objectID,
        itemURL: p.item.itemURL,
      })
    } else {
      push({
        source: 'external',
        objectID: p.objectID,
        itemURL: p.item.itemURL,
      })
    }
  }

  return scope
}

export function useRepackRunner() {
  const sdk = useAuthStore((s) => s.sdk)

  useEffect(() => {
    if (!sdk) return

    // Channel manifest I/O over the locator: prefer the local cache for the
    // read (fresh + no DHT round-trip), commit the rewrite to the locator.
    const channelIO: ChannelManifestIO = {
      readManifest: async (channelID, channelKey) => {
        const cached = useFeedStore.getState().manifests[channelID]
        if (cached) return cached
        const resolved = await resolveChannelViaLocator(sdk, channelKey)
        if (!resolved) throw new Error(`repack: no locator for ${channelID}`)
        return resolved
      },
      commitManifest: (channelID, channelKey, manifest) =>
        commitChannelManifest(sdk, channelID, channelKey, manifest),
    }

    let running = false
    let queued = false
    let stopped = false

    const tick = async () => {
      if (running) {
        queued = true
        return
      }
      running = true
      useStorageActivityStore.getState().setRunning(true)

      try {
        // Loop-until-clean: keep packing batches until pickBatch decides
        // there's nothing worth doing.
        while (!stopped) {
          const auth = useAuthStore.getState()
          const scope = await buildScope(sdk)
          if (scope.length === 0) break

          let result: Awaited<ReturnType<typeof runRepackBatch>>
          try {
            result = await runRepackBatch(sdk, scope, channelIO)
          } catch (e) {
            // One batch failing shouldn't kill the runner. Log and bail
            // out of this tick; next pin event will try again.
            console.warn('repack: batch failed:', e)
            break
          }
          if (!result) break

          // Apply local-state effects of the batch.
          if (result.pinStoreReplacements.length > 0) {
            usePinStore.getState().replaceMany(result.pinStoreReplacements)
          }
          for (const channelID of result.affectedChannelIDs) {
            const sub = auth.subscriptions.find(
              (s) => s.channelID === channelID,
            )
            if (sub) {
              await useFeedStore.getState().refreshChannel(sub)
            }
          }

          // Refresh account snapshot so the storage bar reflects the
          // freed pinnedData.
          usePinStore.getState().refreshAccount(sdk)

          useToastStore
            .getState()
            .addToast(
              `Repacked ${result.reclaimedSlabs} slabs into 1 — storage tidied`,
            )
        }
      } finally {
        running = false
        useStorageActivityStore.getState().setRunning(false)
        if (queued) {
          queued = false
          tick()
        }
      }
    }

    // Trigger 1: app load — catches accumulated waste from prior sessions.
    tick()

    // Trigger 2: an action transitions to success. Covers both library pins
    // (drag-drop intake) and channel publishes.
    let lastSuccessIDs = new Set<string>()
    const unsubQueue = useActionStore.subscribe((state) => {
      const newSuccesses: string[] = []
      for (const a of state.actions) {
        if (a.state === 'success' && !lastSuccessIDs.has(a.id)) {
          newSuccesses.push(a.id)
        }
      }
      lastSuccessIDs = new Set(state.actions.map((a) => a.id))
      if (newSuccesses.length > 0) tick()
    })

    // Trigger 3: pinStore.pinned grows — catches direct PinButton clicks
    // on Read* pages (which call pinStore.pin without going through the
    // upload queue).
    //
    // While a channel-pin batch is fanning out, pinned grows once per item
    // (N times for an N-item channel). Repacking after each would fire N
    // full scope walks against the network mid-batch — wasteful, and it
    // saturates host connections enough to slow the very pins we're
    // running. So defer while pinningChannels is non-empty and run a single
    // pass once the batch drains.
    let lastPinnedCount = usePinStore.getState().pinned.length
    let wasBatchPinning =
      Object.keys(usePinStore.getState().channelPins).length > 0
    const unsubPin = usePinStore.subscribe((state) => {
      const count = state.pinned.length
      const batchPinning = Object.keys(state.channelPins).length > 0
      if (count > lastPinnedCount) {
        lastPinnedCount = count
        if (!batchPinning) tick()
      } else {
        lastPinnedCount = count
      }
      // Batch just finished — repack once over everything it added.
      if (wasBatchPinning && !batchPinning) tick()
      wasBatchPinning = batchPinning
    })

    return () => {
      stopped = true
      unsubQueue()
      unsubPin()
    }
  }, [sdk])
}
