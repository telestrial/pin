import { useEffect } from 'react'
import {
  type ItemReplacement,
  migrateChannelManifest,
} from '../core/legacyMigration'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { useUploadQueueStore } from '../stores/uploadQueue'

// One-shot migration: walks own-channel manifests on app load and rewrites
// any legacy item (type !== 'text') into the new post-with-attachment shape.
// Same triggering shape as useOrphanSweep — wait for manifests + uploads to
// settle, then run once. After it does its job and the user confirms clean,
// this hook + its imports can come out in a follow-up commit (mirroring the
// May 9 useLegacyAttachmentBackfill pattern).
const SETTLE_DELAY_MS = 5000

export function useLegacyItemMigration() {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)

  useEffect(() => {
    if (!sdk || !agent) return
    let cancelled = false

    async function run() {
      await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS))
      if (cancelled) return

      const auth = useAuthStore.getState()
      const feed = useFeedStore.getState()
      const queue = useUploadQueueStore.getState()

      const uploadsIdle = queue.tasks.every(
        (t) => t.state === 'success' || t.state === 'failed',
      )
      if (!uploadsIdle) return

      const allManifestsLoaded = auth.myChannels.every(
        (c) => feed.manifests[c.channelID] !== undefined,
      )
      if (auth.myChannels.length > 0 && !allManifestsLoaded) return

      let totalMigrated = 0
      const replacementsByOldID = new Map<string, ItemReplacement>()

      for (const channel of auth.myChannels) {
        if (cancelled) return
        try {
          const result = await migrateChannelManifest(sdk!, agent!, channel)
          if (!result) continue
          totalMigrated += result.migratedCount
          for (const r of result.replacements) {
            replacementsByOldID.set(r.oldObjectID, r)
          }
          console.log(
            `legacy-migration: migrated ${result.migratedCount} items in ${channel.channelID}`,
          )
        } catch (e) {
          console.warn(
            `legacy-migration: failed for channel ${channel.channelID}:`,
            e,
          )
        }
      }

      if (cancelled) return
      if (totalMigrated === 0) return

      // Author-self-pinned entries reference the legacy object IDs; rewrite
      // them to point at the new posts. Subscribers' pinStore entries (in
      // other clients) are snapshots and stay legacy by design.
      if (replacementsByOldID.size > 0) {
        usePinStore.setState((s) => ({
          pinned: s.pinned.map((p) => {
            const r = replacementsByOldID.get(p.objectID)
            if (!r) return p
            return {
              ...p,
              objectID: r.newObjectID,
              item: r.newItem,
            }
          }),
        }))
      }

      // Repopulate local feed state from the now-migrated manifests so the UI
      // updates immediately — JetStream will fire commits too but this avoids
      // the dependency.
      await useFeedStore.getState().refresh(auth.subscriptions)
      usePinStore.getState().refreshAccount(sdk!)

      useToastStore
        .getState()
        .addToast(
          `Migrated ${totalMigrated} legacy ${totalMigrated === 1 ? 'item' : 'items'} to the new shape`,
        )
    }

    run()

    return () => {
      cancelled = true
    }
  }, [sdk, agent])
}
