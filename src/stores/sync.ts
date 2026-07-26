import { create } from 'zustand'

// Live-sync status — the surface for "are my instances of one identity in parity."
// Populated by useRendezvousSync (the symmetric auto-discovery loop). Purely runtime;
// nothing here is persisted (it's a live status, not durable state).
//
// Symmetric by design: EVERY open instance (desktop or web tab) is a full peer — it
// advertises itself AND syncs to another. Two independent dimensions:
//   - advertising: I've published my coords, so my other devices can find me.
//   - phase: my own connection to a peer (searching → live, or error).
// The only real difference between desktop and web is physics (always-on + durable),
// not capability — so there's deliberately no host/client role here.

export type SyncPhase = 'off' | 'searching' | 'live' | 'error'

type SyncState = {
  // I've published my coords to the rendezvous (discoverable by my other devices).
  advertising: boolean
  // My own connection to a peer.
  phase: SyncPhase
  // Human-facing one-liner.
  detail: string | null
  // Last live-sync event label (insert-remote / sync-finished / neighbor-up …).
  lastEvent: string | null
  error: string | null
  set: (
    p: Partial<Pick<SyncState, 'advertising' | 'phase' | 'detail' | 'error'>>,
  ) => void
  setEvent: (label: string) => void
  reset: () => void
}

const INITIAL = {
  advertising: false,
  phase: 'off' as SyncPhase,
  detail: null,
  lastEvent: null,
  error: null,
}

export const useSyncStore = create<SyncState>()((set) => ({
  ...INITIAL,
  set: (p) => set(p),
  setEvent: (label) => set({ lastEvent: label }),
  reset: () => set(INITIAL),
}))
