import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { useSyncStore } from '../../stores/sync'
import { openDocs, startSync } from '../docs'
import { inTauri } from '../openExternal'
import {
  advertiseInstance,
  discoverPeers,
  resolvePeerTicket,
} from '../rendezvous'

// Productized instance sync — replaces the dev panel / __pinSync console with an
// automatic loop that keeps two iroh-docs replicas of ONE identity in parity, no
// manual ticket. This is persistence infrastructure, not a demo: the durable repo is
// the ball game, and it should stay converged across every device you're signed in on.
//
// SYMMETRIC by design. Every open instance — desktop OR web tab — is a full peer:
//   - advertiseLoop: publish my own coords into the additive rendezvous directory so
//     my other devices can find me, and serve them. Both desktop and web do this;
//     a browser tab serves + is-synced-from fine (verified cross-device).
//   - connectLoop: discover a live peer and sync to it (one import reconciles both
//     directions). Both do this too.
// The ONLY asymmetry is physics + one binding detail: a desktop is always-on and
// durable (so the directory prefers it), and docs.ts startSync routes through the
// native Curator on desktop (curator_start_sync) vs the wasm engine on web.
//
// Cost of being a real peer: advertising means the engine + a relay endpoint come up
// even on a solo web session (a tab must be online to be discoverable). That's the
// honest price of "a browser tab is a full node," and slice 2 needs the engine open
// anyway.

// Refresh cadence for our directory entry (must be well under ENTRY_TTL_SEC so we
// don't age out; also re-fans the ticket in case our addr changed).
const REFRESH_MS = 4 * 60_000
// Retry cadence before the first advertise/connect succeeds.
const RETRY_MS = 60_000
const RETRY_SOON_MS = 8_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A stable per-page-load instance id (public salt for our per-instance rendezvous
// key). One per page load so StrictMode re-mounts upsert the same directory entry
// rather than spawning a second.
const INSTANCE_ID = Array.from(crypto.getRandomValues(new Uint8Array(8)))
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')

export function useRendezvousSync() {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!client || !storedKeyHex) return
    const hex = storedKeyHex
    const durable = inTauri() // always-on node → the directory prefers it
    let cancelled = false
    const sync = useSyncStore.getState()

    // Advertise (and keep advertising) so my other devices can discover this one.
    async function advertiseLoop() {
      let advertised = false
      while (!cancelled) {
        try {
          await openDocs(hex)
          await advertiseInstance(hex, INSTANCE_ID, durable)
          advertised = true
          if (!cancelled) sync.set({ advertising: true, error: null })
        } catch (e) {
          if (!cancelled) sync.set({ error: String(e) })
        }
        await sleep(advertised ? REFRESH_MS : RETRY_SOON_MS)
      }
    }

    // Discover a live peer and sync to it — one import reconciles both directions.
    async function connectLoop() {
      while (!cancelled) {
        try {
          const peers = await discoverPeers(hex, INSTANCE_ID)
          for (const peer of peers) {
            if (cancelled) return
            const ticket = await resolvePeerTicket(hex, peer.id)
            if (!ticket) continue
            await openDocs(hex)
            await startSync(ticket, (label) =>
              useSyncStore.getState().setEvent(label),
            )
            if (cancelled) return
            sync.set({
              phase: 'live',
              detail: 'Synced with your other devices.',
              error: null,
            })
            return // live-sync established; the event pump persists.
          }
          if (!cancelled)
            sync.set({
              phase: 'searching',
              detail:
                peers.length === 0
                  ? 'No other device online right now.'
                  : 'Reaching your other device…',
              error: null,
            })
        } catch (e) {
          if (!cancelled)
            sync.set({ phase: 'error', detail: null, error: String(e) })
        }
        await sleep(RETRY_MS)
      }
    }

    sync.set({ phase: 'searching', detail: 'Looking for your other devices…' })
    void advertiseLoop()
    void connectLoop()

    return () => {
      cancelled = true
      useSyncStore.getState().reset()
    }
  }, [client, storedKeyHex])
}
