import type { Sdk } from '@siafoundation/sia-storage'
import { useEffect } from 'react'
import { resolveChannelImageIDs } from '../core/channelImages'
import { sweepOrphans } from '../core/orphanSweep'
import { getProfileRecord } from '../core/profile'
import { isValidAttachment } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import { useStorageActivityStore } from '../stores/storageActivity'
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

  // Channel manifest items + their attachments. Both are independently
  // pinned in our scope; missing either from the known set classifies
  // the bytes as orphan and the sweep would delete them.
  const attachmentURLsToResolve: string[] = []
  for (const entry of feed.entries) {
    if (!myChannelIDSet.has(entry.channel.channelID)) continue
    if (entry.item.id) ids.add(entry.item.id)
    if (!entry.item.attachments) continue
    for (const att of entry.item.attachments) {
      // Pre-schema malformed entries can be missing url/mimeType —
      // skip them so we don't crash the WASM bridge with undefined.
      if (!isValidAttachment(att)) continue
      if (att.objectID) {
        ids.add(att.objectID)
      } else {
        // Legacy attachment without stored objectID — resolve via
        // sharedObject. Repack will backfill objectID on its next pass.
        attachmentURLsToResolve.push(att.url)
      }
    }
  }

  // Channel images (avatar + cover) per owned channel — manifest only stores
  // the share URL, so resolve via sharedObject(url).id(). If ANY image
  // resolution fails, we bail on the sweep entirely — incomplete known set is
  // too risky to proceed with destructive deletes.
  const images = await resolveChannelImageIDs(sdk, auth.myChannels, feed.manifests)
  if (images.failed.length > 0) {
    for (const f of images.failed) {
      console.warn(
        `sweep: ${f.kind} resolution failed for ${f.channelID}, bailing:`,
        f.error,
      )
    }
    return { ok: false, ids }
  }
  for (const img of images.resolved) {
    ids.add(img.objectID)
  }

  // Resolve legacy attachments. Per-attachment failures are logged and
  // skipped, NOT a hard bail like cover art — if sharedObject returns
  // "object not found" for an attachment URL, the bytes simply aren't
  // pinned in our scope, so they won't appear in objectEvents either
  // and the sweep has nothing to do with them. After repack backfills
  // attachment.objectID this path goes quiet for everything that's
  // passed through repack.
  await Promise.all(
    attachmentURLsToResolve.map(async (url) => {
      try {
        const obj = await sdk.sharedObject(url)
        ids.add(obj.id())
      } catch (e) {
        console.warn(`sweep: skipping attachment ${url}:`, e)
      }
    }),
  )

  // pinStore — library + external pins
  for (const p of pin.pinned) {
    if (p.objectID) ids.add(p.objectID)
  }

  // Profile avatar + cover (one record per user, rkey 'self'). Like
  // cover art, these store share URLs in the record body — resolve to
  // object IDs via sharedObject. Bail on any failure: deleting profile
  // bytes by mistake would orphan the URLs in the profile record.
  if (auth.atprotoDID) {
    try {
      const profile = await getProfileRecord(auth.atprotoDID)
      const profileURLs = [profile?.avatarURL, profile?.coverURL].filter(
        (u): u is string => typeof u === 'string',
      )
      for (const url of profileURLs) {
        try {
          const obj = await sdk.sharedObject(url)
          ids.add(obj.id())
        } catch (e) {
          console.warn(
            `sweep: profile-image resolution failed for ${url}, bailing:`,
            e,
          )
          return { ok: false, ids }
        }
      }
    } catch (e) {
      console.warn('sweep: profile fetch failed, bailing:', e)
      return { ok: false, ids }
    }
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

      useStorageActivityStore.getState().setSweeping(true)
      try {
        if (!sdk) return
        const { ok, ids } = await buildKnownIDs(sdk)
        if (cancelled) return
        if (!ok) return // cover-art resolution failed; skip this session

        const result = await sweepOrphans(sdk, ids)
        if (cancelled) return

        if (result.orphansDeleted > 0) {
          usePinStore.getState().refreshAccount(sdk)

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
        if (!cancelled) useStorageActivityStore.getState().setSweeping(false)
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [sdk])
}
