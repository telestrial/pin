import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import {
  openDocs,
  startIdentityLoop,
  startInstanceLoop,
  startKeepAliveLoop,
  startRepackLoop,
} from '../docs'

// Turn on the Curator's background loops, and then get out of the way.
//
// The loops are Rust (crates/pin-curator), running in whichever engine this instance
// has — native on desktop, wasm in a tab. This hook exists only because something has
// to say "go" once the identity is known; it holds no logic of its own and gets
// nothing back. That's the shape to keep as more loops land here.
//
//   keep-alive — republish each owned channel's pkarr locator so the record doesn't
//     age off the Mainline DHT. It used to be this hook's own body: a republish on
//     mount, once per channel, no cadence — so an instance left running republished
//     at minute zero and then watched the record expire under it. A locator that
//     expires takes the channel's discoverability with it.
//   instance — record that this node id is a live endpoint of this identity, so the
//     identity's published coordinates can be the SET of live endpoints rather than
//     whichever instance wrote last.
//   identity — publish those coordinates: one packet under the did:dht key carrying
//     the directory pointer, the doc namespace, and every live endpoint. This was two
//     writers until now — the Curator at startup and a React effect seconds later,
//     each publishing a whole packet over the other's half.
//
// Started independently: one loop failing to start must not keep the other off.

export function useCuratorLoops() {
  const client = useAuthStore((s) => s.client)
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)
  // The curation kill switch (Curate page). Off means this instance stops working the
  // network in the background — including keeping its own channels findable, and
  // including offering itself as somewhere to reach this identity.
  const curationEnabled = useAuthStore((s) => s.curationEnabled)

  useEffect(() => {
    if (!curationEnabled || !client || !appKeyHex) return
    let cancelled = false

    void (async () => {
      const namespaceId = await openDocs(appKeyHex)
      if (cancelled) return
      await Promise.allSettled([
        startKeepAliveLoop(appKeyHex),
        startRepackLoop(appKeyHex),
        startInstanceLoop(),
        startIdentityLoop(appKeyHex, namespaceId),
      ])
    })()

    return () => {
      cancelled = true
    }
  }, [client, appKeyHex, curationEnabled])
}
