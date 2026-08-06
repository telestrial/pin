import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { refreshChannelLocator } from '../channelLocator'

// Keep-alive for owned channels' pkarr locators. Publishing a channel write
// commits its locator inline (lib/channelWrites → commitChannelManifest), so
// this hook doesn't react to manifest changes. Its one job is TTL keep-alive: a
// pkarr record carries a ~1h TTL and ages off the Mainline DHT if nobody
// republishes it, so a channel published in an earlier session (tab since
// closed) could become unresolvable to subscribers.
//
// It refreshes the POINTER only (re-sign + re-publish the existing records) — no
// new Sia object, no delete. Re-uploading the manifest here would churn a 40 MiB
// slab per session AND force an extra supersede-delete, widening the window where
// a reader resolves a stale pointer to a just-deleted object. Once per channel
// per session, guarded by keptAlive. Lazy: pkarr wasm only boots for an owner.

export function useChannelLocatorPublish() {
  const client = useAuthStore((s) => s.client)
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!client || !appKeyHex) return

    let cancelled = false
    const keptAlive = new Set<string>()

    const keepAlive = async () => {
      const owned = useAuthStore.getState().myChannels
      for (const c of owned) {
        if (cancelled) return
        if (keptAlive.has(c.channelID)) continue
        keptAlive.add(c.channelID)
        try {
          await refreshChannelLocator(appKeyHex, c.channelKey, c.channelID)
        } catch (e) {
          keptAlive.delete(c.channelID) // let a later tick retry
          console.warn(
            `channel locator keep-alive failed for ${c.channelID}:`,
            e,
          )
        }
      }
    }

    // myChannels can populate/change after mount; re-run to catch new owners.
    const unsubAuth = useAuthStore.subscribe((s, p) => {
      if (s.myChannels !== p.myChannels) void keepAlive()
    })
    void keepAlive()

    return () => {
      cancelled = true
      unsubAuth()
    }
  }, [client, appKeyHex])
}
