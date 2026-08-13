import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { useSyncStore } from '../../stores/sync'
import {
  isRemoteChange,
  openDocs,
  type RendezvousReport,
  startRendezvousLoop,
  subscribeDocChanges,
} from '../docs'

// The frontend half of the Curator's rendezvous loop.
//
// The loop itself is Rust (crates/pin-curator), running in whichever engine this
// instance has — the native Curator on desktop, the wasm engine in a tab. It advertises
// where this instance can be reached and live-syncs this identity's doc with the other
// instances it finds. Symmetric: every instance advertises AND connects, so a tab is a
// peer rather than a client.
//
// It ran as a React effect until now, which meant a desktop only stayed discoverable
// while a webview was alive — the tray keeps one hidden, so the always-on-ness was
// borrowed rather than owned. Close that webview and your phone could no longer find
// your desktop.
//
// So this hook does two small things. It starts the loop, and it turns what the loop
// reports into the status the Curate page renders. It holds no rendezvous logic: the
// directory, the tickets and the retry cadence are all the loop's.

/** Sync events aren't reported by the loop — it starts a sync and moves on. So "is this
 *  actually live" comes from the doc's own change feed instead, which is the better
 *  signal anyway: a peer's write arriving says more than a protocol label does. */
function describe(collection: string, rkey: string, kind: string): string {
  return collection ? `${kind} ${collection}/${rkey}` : kind
}

export function useRendezvousSync() {
  const client = useAuthStore((s) => s.client)
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)
  // The curation kill switch (Curate page). Same control, same meaning on both
  // platforms: off means this instance stops working the network in the background —
  // including offering itself as somewhere to reach this identity.
  const curationEnabled = useAuthStore((s) => s.curationEnabled)

  useEffect(() => {
    if (!curationEnabled) {
      useSyncStore.getState().reset()
      return
    }
    if (!client || !appKeyHex) return
    let cancelled = false

    const sync = useSyncStore.getState()
    sync.set({ phase: 'searching', detail: 'Looking for your other devices…' })

    let unsubscribe: (() => void) | null = null

    void (async () => {
      try {
        // After the doc is open, not before: on desktop the change feed is served by
        // the Curator's engine, and attaching to one that hasn't come up yet fails
        // silently for the rest of the session.
        await openDocs(appKeyHex)
        if (cancelled) return
        unsubscribe = subscribeDocChanges(({ collection, rkey, kind }) => {
          if (!cancelled && isRemoteChange(kind)) {
            useSyncStore.getState().setEvent(describe(collection, rkey, kind))
          }
        })
        await startRendezvousLoop(appKeyHex, (report) => {
          if (cancelled) return
          apply(JSON.parse(report) as RendezvousReport)
        })
      } catch (e) {
        if (!cancelled)
          useSyncStore
            .getState()
            .set({ phase: 'error', detail: null, error: String(e) })
      }
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
      useSyncStore.getState().reset()
    }
  }, [client, appKeyHex, curationEnabled])
}

/** Map one pass's report onto the two independent things the page shows: whether this
 *  instance is findable, and whether it has found anyone. */
function apply(report: RendezvousReport) {
  if (report.error) {
    useSyncStore
      .getState()
      .set({ phase: 'error', detail: null, error: report.error })
    return
  }
  const syncing = report.syncing ?? 0
  const peers = report.peers ?? 0
  useSyncStore.getState().set({
    advertising: report.advertised ?? false,
    phase: syncing > 0 ? 'live' : 'searching',
    detail:
      syncing > 0
        ? syncing === 1
          ? 'Synced with your other device.'
          : `Synced with ${syncing} of your devices.`
        : peers > 0
          ? 'Reaching your other device…'
          : 'No other device online right now.',
    error: null,
  })
}
