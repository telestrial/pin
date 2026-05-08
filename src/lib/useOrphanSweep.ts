import type { Sdk } from '@siafoundation/sia-storage'
import { useEffect } from 'react'
import { sweepOrphans } from '../core/orphanSweep'
import { fetchAccountSnapshot } from '../core/pin'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import { useRepackStore } from '../stores/repack'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

// Defer the sweep on app load by this much so manifests have a chance to
// fetch, pinStore can hydrate from localStorage, and any in-flight
// uploads can finish. Sweep only runs once per session.
const SETTLE_DELAY_MS = 5000

async function buildKnownIDs(sdk: Sdk): Promise<{
  ok: boolean
  ids: Set<string>
}> {
  const auth = useAuthStore.getState()
  const feed = useFeedStore.getState()
  const pin = usePinStore.getState()
  const ids = new Set<string>()

  // Settings — explicit positive identification. The metadata-shape
  // skip in core/orphanSweep is the second line of defense.
  if (auth.settingsObjectID) ids.add(auth.settingsObjectID)

  const myChannelIDSet = new Set(auth.myChannels.map((c) => c.channelID))

  // Channel manifest items
  for (const entry of feed.entries) {
    if (!myChannelIDSet.has(entry.channel.channelID)) continue
    if (entry.item.id) ids.add(entry.item.id)
  }

  // Cover art per owned channel — manifest only stores the share URL,
  // so resolve via sharedObject(url).id(). If ANY cover-art resolution
  // fails, we bail on the sweep entirely — incomplete known set is too
  // risky to proceed with destructive deletes.
  let coverResolutionOK = true
  await Promise.all(
    auth.myChannels.map(async (channel) => {
      const manifest = feed.manifests[channel.channelID]
      if (!manifest?.coverArt) return
      try {
        const obj = await sdk.sharedObject(manifest.coverArt.itemURL)
        ids.add(obj.id())
      } catch (e) {
        console.warn(
          `sweep: cover-art resolution failed for ${channel.channelID}, bailing:`,
          e,
        )
        coverResolutionOK = false
      }
    }),
  )

  if (!coverResolutionOK) {
    return { ok: false, ids }
  }

  // pinStore — library + external pins
  for (const p of pin.pinned) {
    if (p.objectID) ids.add(p.objectID)
  }

  return { ok: true, ids }
}

export function useOrphanSweep() {
  const sdk = useAuthStore((s) => s.sdk)

  useEffect(() => {
    if (!sdk) return
    let cancelled = false

    async function run() {
      await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS))
      if (cancelled) return

      const auth = useAuthStore.getState()
      const feed = useFeedStore.getState()
      const queue = useUploadQueueStore.getState()

      // Don't sweep mid-upload — in-flight bytes are pinned but not yet
      // tracked anywhere we'd find them. Bail; next session will retry.
      const uploadsIdle = queue.tasks.every(
        (t) => t.state === 'success' || t.state === 'failed',
      )
      if (!uploadsIdle) return

      // Don't sweep if owned-channel manifests haven't loaded yet —
      // their items wouldn't be in the known set and would look like
      // orphans.
      const allManifestsLoaded = auth.myChannels.every(
        (c) => feed.manifests[c.channelID] !== undefined,
      )
      if (auth.myChannels.length > 0 && !allManifestsLoaded) return

      useRepackStore.getState().setSweeping(true)
      try {
        if (!sdk) return
        const { ok, ids } = await buildKnownIDs(sdk)
        if (cancelled) return
        if (!ok) return // cover-art resolution failed; skip this session

        const result = await sweepOrphans(sdk, ids)
        if (cancelled) return

        if (result.orphansDeleted > 0) {
          fetchAccountSnapshot(sdk)
            .then((account) => usePinStore.setState({ account }))
            .catch(() => {})

          useToastStore
            .getState()
            .addToast(
              `Cleaned up ${result.orphansDeleted} orphan ${
                result.orphansDeleted === 1 ? 'object' : 'objects'
              }`,
            )
        }
      } catch (e) {
        console.warn('sweep: failed:', e)
      } finally {
        if (!cancelled) useRepackStore.getState().setSweeping(false)
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [sdk])
}
