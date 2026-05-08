import type { Sdk } from '@siafoundation/sia-storage'
import { useEffect } from 'react'
import { fetchAccountSnapshot } from '../core/pin'
import { runRepackBatch, type ScopeRef } from '../core/repack'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { LIBRARY_CHANNEL } from './pinUpload'
import { usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'
import { useRepackStore } from '../stores/repack'

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
  const myChannelIDSet = new Set(auth.myChannels.map((c) => c.channelID))
  const channelKeyByID = new Map(
    auth.myChannels.map((c) => [c.channelID, c.channelKey]),
  )

  for (const entry of feed.entries) {
    if (!myChannelIDSet.has(entry.channel.channelID)) continue
    const channelKey = channelKeyByID.get(entry.channel.channelID)
    if (!channelKey) continue
    if (!entry.item.id || !entry.item.itemURL) continue
    scope.push({
      source: 'channel',
      objectID: entry.item.id,
      itemURL: entry.item.itemURL,
      channelID: entry.channel.channelID,
      channelKey,
    })
  }

  // Cover art per owned channel. SDK call per cover (one per channel),
  // bounded by myChannels.length — small in practice.
  await Promise.all(
    auth.myChannels.map(async (channel) => {
      const manifest = feed.manifests[channel.channelID]
      if (!manifest?.coverArt) return
      try {
        const obj = await sdk.sharedObject(manifest.coverArt.itemURL)
        scope.push({
          source: 'channel',
          objectID: obj.id(),
          itemURL: manifest.coverArt.itemURL,
          channelID: channel.channelID,
          channelKey: channel.channelKey,
        })
      } catch (e) {
        console.warn(
          `repack: failed to resolve cover art for ${channel.channelID}:`,
          e,
        )
      }
    }),
  )

  for (const p of pin.pinned) {
    if (!p.objectID) continue
    if (myChannelIDSet.has(p.channel.channelID)) continue
    if (p.channel.channelID === LIBRARY_CHANNEL.channelID) {
      scope.push({
        source: 'library',
        objectID: p.objectID,
        itemURL: p.item.itemURL,
      })
    } else {
      scope.push({
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

    let running = false
    let queued = false
    let stopped = false

    const tick = async () => {
      if (running) {
        queued = true
        return
      }
      running = true
      useRepackStore.getState().setRunning(true)

      try {
        // Loop-until-clean: keep packing batches until pickBatch decides
        // there's nothing worth doing.
        while (!stopped) {
          const auth = useAuthStore.getState()
          const scope = await buildScope(sdk)
          if (scope.length === 0) break

          let result
          try {
            result = await runRepackBatch(sdk, auth.atprotoAgent, scope)
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
          fetchAccountSnapshot(sdk)
            .then((account) => usePinStore.setState({ account }))
            .catch(() => {})

          useToastStore
            .getState()
            .addToast(
              `Repacked ${result.reclaimedSlabs} slabs into 1 — storage tidied`,
            )
        }
      } finally {
        running = false
        useRepackStore.getState().setRunning(false)
        if (queued) {
          queued = false
          tick()
        }
      }
    }

    // Trigger 1: app load — catches accumulated waste from prior sessions.
    tick()

    // Trigger 2: an upload-runner task transitions to success. Covers
    // both library pins (drag-drop intake) and channel publishes.
    let lastSuccessIDs = new Set<string>()
    const unsubQueue = useUploadQueueStore.subscribe((state) => {
      const newSuccesses: string[] = []
      for (const t of state.tasks) {
        if (t.state === 'success' && !lastSuccessIDs.has(t.id)) {
          newSuccesses.push(t.id)
        }
      }
      lastSuccessIDs = new Set(state.tasks.map((t) => t.id))
      if (newSuccesses.length > 0) tick()
    })

    // Trigger 3: pinStore.pinned grows — catches direct PinButton clicks
    // on Read* pages (which call pinStore.pin without going through the
    // upload queue).
    let lastPinnedCount = usePinStore.getState().pinned.length
    const unsubPin = usePinStore.subscribe((state) => {
      const count = state.pinned.length
      if (count > lastPinnedCount) {
        lastPinnedCount = count
        tick()
      } else {
        lastPinnedCount = count
      }
    })

    return () => {
      stopped = true
      unsubQueue()
      unsubPin()
    }
  }, [sdk])
}
