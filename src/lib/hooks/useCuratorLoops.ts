import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { useCuratorStore } from '../../stores/curator'
import {
  openDocs,
  startChannelDocLoop,
  startChannelSyncLoop,
  startDeliverLoop,
  startDiscoverLoop,
  startEngagementLoop,
  startIdentityLoop,
  startInstanceLoop,
  startKeepAliveLoop,
  startRepackLoop,
  startSnapshotLoop,
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
//   channel-docs — serve each owned channel as a live replica and keep a read ticket
//     for it published, so a subscriber is pushed a new post instead of waiting for
//     the next poll. It reads the sealed manifest straight out of the doc and copies
//     it across, which is why it needs no Sia session and never sees the content.
//   channel-sync — the subscriber counterpart: import each subscribed channel from its
//     author and write what arrives into `sub/<id>`, the same record the polling rung
//     writes. So a pushed manifest and a polled one are the same thing downstream.
//   snapshot — mirror the whole doc to Sia and publish the pointer to it. The identity's
//     durability floor, and until now a side effect of two separate React effects, each
//     debouncing independently — so a settings change and a pin in the same window meant
//     two whole-doc uploads racing on one pointer.
//   identity — publish those coordinates: one packet under the did:dht key carrying
//     the directory pointer, the doc namespace, and every live endpoint. This was two
//     writers until now — the Curator at startup and a React effect seconds later,
//     each publishing a whole packet over the other's half.
//   engagement — read what the graph has endorsed, verify it, hold it, and publish a
//     tally per subject. The author's half of engagement, and why there is no AppView:
//     nobody writes into anyone else's repo, so the person whose surface it is assembles
//     the count themselves. Doubles as the retention check.
//
// Started independently: one loop failing to start must not keep the other off.
//
// TWO GROUPS, and the split is the whole of what `docRestore` is for. A loop that
// publishes CURRENT STATE assembled from the doc says, by publishing, that what the doc
// holds is all this identity has — so running one over a doc nobody put back turns a
// failure to read into an authoritative write. `identity` republishes the directory,
// where an absent endorsement reads as a withdrawal. `snapshot` mirrors the doc it finds
// and moves the durable pointer onto it. `engagement` folds held records into published
// tallies. The other seven read, or write records that stand on their own, and start as
// soon as the engine is up.

// Settled rather than all, so one loop failing to start doesn't take the rest with it.
// But a rejection here is a loop that will not run for this whole session, and swallowing
// it silently is how a Curator that had quietly stopped folding engagement looked exactly
// like one with nothing to fold.
async function startAll(named: [string, Promise<unknown>][]): Promise<void> {
  const results = await Promise.allSettled(named.map(([, p]) => p))
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`curator loop "${named[i][0]}" did not start:`, r.reason)
    }
  })
}

export function useCuratorLoops() {
  const client = useAuthStore((s) => s.client)
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)
  // The curation kill switch (Curate page). Off means this instance stops working the
  // network in the background — including keeping its own channels findable, and
  // including offering itself as somewhere to reach this identity.
  const curationEnabled = useAuthStore((s) => s.curationEnabled)
  // See `useDocRestore`. Desktop reports ready having read nothing; a tab reports it once
  // the snapshot is back, or once the locator has said there is none to put back.
  const docRestored = useCuratorStore((s) => s.docRestore === 'ready')

  useEffect(() => {
    if (!curationEnabled || !client || !appKeyHex) return
    let cancelled = false

    void (async () => {
      await openDocs(appKeyHex)
      if (cancelled) return
      await startAll([
        ['keep-alive', startKeepAliveLoop(appKeyHex)],
        ['channel-doc', startChannelDocLoop(appKeyHex)],
        ['channel-sync', startChannelSyncLoop(appKeyHex)],
        ['repack', startRepackLoop(appKeyHex)],
        ['instance', startInstanceLoop()],
        ['deliver', startDeliverLoop(appKeyHex)],
        ['discover', startDiscoverLoop(appKeyHex)],
      ])
    })()

    return () => {
      cancelled = true
    }
  }, [client, appKeyHex, curationEnabled])

  // Its own effect, so the seven above are started once and stay started when this one
  // is still waiting on the restore.
  useEffect(() => {
    if (!curationEnabled || !client || !appKeyHex || !docRestored) return
    let cancelled = false

    void (async () => {
      const namespaceId = await openDocs(appKeyHex)
      if (cancelled) return
      await startAll([
        ['snapshot', startSnapshotLoop(appKeyHex)],
        ['identity', startIdentityLoop(appKeyHex, namespaceId)],
        ['engagement', startEngagementLoop(appKeyHex)],
      ])
    })()

    return () => {
      cancelled = true
    }
  }, [client, appKeyHex, curationEnabled, docRestored])
}
