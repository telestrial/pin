import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { commitChannelManifest } from '../channelLocator'

// Keep-alive for owned channels' pkarr locators. Publishing a channel write
// commits its locator inline (lib/channelWrites → commitChannelManifest), so
// this hook no longer reacts to manifest *changes* — that would double-publish
// on every write. Its one remaining job is TTL keep-alive: a pkarr record
// carries a 1h TTL and ages off the Mainline DHT if nobody republishes it, so a
// channel published in an earlier session (tab since closed) would become
// unresolvable to subscribers. On load we republish each owned channel's
// current manifest ONCE, refreshing the DHT pointer for the session.
//
// Guarded by a per-channel "kept alive this session" set so a subsequent inline
// commit (which updates feedStore.manifests) doesn't retrigger a republish.
// Lazy: pkarr wasm only boots once you actually own a channel with a manifest.

export function useChannelLocatorPublish() {
  const sdk = useAuthStore((s) => s.sdk)

  useEffect(() => {
    if (!sdk) return

    let cancelled = false
    const keptAlive = new Set<string>()

    const keepAlive = async () => {
      const owned = new Map(
        useAuthStore
          .getState()
          .myChannels.map((c) => [c.channelID, c.channelKey]),
      )
      const { manifests } = useFeedStore.getState()
      for (const [channelID, channelKey] of owned) {
        if (cancelled) return
        if (keptAlive.has(channelID)) continue
        const manifest = manifests[channelID]
        if (!manifest) continue // not loaded yet — a later change fires this again
        keptAlive.add(channelID)
        try {
          await commitChannelManifest(sdk, channelID, channelKey, manifest)
        } catch (e) {
          keptAlive.delete(channelID) // let a later tick retry
          console.warn(`channel locator keep-alive failed for ${channelID}:`, e)
        }
      }
    }

    // Manifests load asynchronously after mount, and myChannels can change; both
    // may reveal an owned channel we haven't kept alive yet.
    const unsubFeed = useFeedStore.subscribe((s, p) => {
      if (s.manifests !== p.manifests) void keepAlive()
    })
    const unsubAuth = useAuthStore.subscribe((s, p) => {
      if (s.myChannels !== p.myChannels) void keepAlive()
    })
    void keepAlive()

    return () => {
      cancelled = true
      unsubFeed()
      unsubAuth()
    }
  }, [sdk])
}
