import { useEffect } from 'react'
import { reconcileGhostChannels } from '../../core/channels'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { useToastStore } from '../../stores/toast'
import { flushSettingsBestEffort } from './useSettingsSync'

// Once-guard across StrictMode's double-mount (and any remount). settingsLoaded
// only flips once per session, so this fires ~once anyway; the guard keeps the
// async body from running twice.
let reconciled = false

// On load, prune owned channels whose atproto record is gone — "ghosts" left
// behind when a retract deleted the record but its settings save failed. Runs
// once after settings-sync has populated the channel list (hydrateSettings
// sets myChannels + settingsLoaded atomically, so there's no empty-list race).
//
// Self-healing: the prune is local first, then persisted via the settings
// flush. If that flush fails (flaky network), the dirty bit + a re-run on the
// next load heal it — a ghost's record stays 404, so re-classification is
// idempotent. Records that merely fail to load transiently are left untouched.
export function useGhostReconciliation() {
  const settingsLoaded = useAuthStore((s) => s.settingsLoaded)
  const did = useAuthStore((s) => s.atprotoDID)

  useEffect(() => {
    if (!settingsLoaded || !did || reconciled) return
    reconciled = true

    void (async () => {
      const channelIDs = useAuthStore
        .getState()
        .myChannels.map((c) => c.channelID)
      if (channelIDs.length === 0) return

      let ghosts: string[]
      try {
        ghosts = await reconcileGhostChannels(did, channelIDs)
      } catch (e) {
        console.warn('Ghost reconciliation failed:', e)
        return
      }
      if (ghosts.length === 0) return

      const auth = useAuthStore.getState()
      const feed = useFeedStore.getState()
      for (const id of ghosts) {
        auth.removeMyChannel(id)
        auth.removeSubscription(id) // owners auto-subscribe, so drop both
        feed.removeChannel(id)
      }
      await flushSettingsBestEffort()

      useToastStore
        .getState()
        .addToast(
          `Cleaned up ${ghosts.length} deleted ${
            ghosts.length === 1 ? 'channel' : 'channels'
          }`,
        )
    })()
  }, [settingsLoaded, did])
}
