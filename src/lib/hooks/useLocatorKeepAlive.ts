import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { openDocs, startKeepAliveLoop } from '../docs'

// Start the Curator's locator keep-alive loop, and then get out of the way.
//
// The loop is Rust (crates/pin-curator), running in whichever engine this instance
// has. It republishes each owned channel's pkarr pointer so the record doesn't age
// off the Mainline DHT — a locator that expires takes the channel's discoverability
// with it, and the subscriber's symptom is the channel simply not resolving.
//
// It used to be this hook's own body: a republish on mount, guarded by a set so each
// channel was only ever done once, and no cadence at all. So an instance left running
// republished at minute zero and then watched the record expire under it — the hook's
// own comment described the failure it wasn't preventing. Being a loop in the Curator
// is the fix, because "keeps happening with nobody watching" is what the Curator is.
//
// Nothing comes back to the UI: the loop's whole output is DHT records, which the app
// never reads on this path. The author already knows their own pointer.

export function useLocatorKeepAlive() {
  const client = useAuthStore((s) => s.client)
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)
  // The curation kill switch (Curate page), same as the pull loop respects. Off means
  // this instance stops working the network in the background — including keeping its
  // own channels findable.
  const curationEnabled = useAuthStore((s) => s.curationEnabled)

  useEffect(() => {
    if (!curationEnabled || !client || !appKeyHex) return
    let cancelled = false
    void (async () => {
      await openDocs(appKeyHex)
      if (cancelled) return
      await startKeepAliveLoop(appKeyHex)
    })()
    return () => {
      cancelled = true
    }
  }, [client, appKeyHex, curationEnabled])
}
