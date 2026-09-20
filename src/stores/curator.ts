import { create } from 'zustand'

// The web instance's curation status — the fields only the running hooks know.
//
// On desktop these come off the native Curator's IPC status struct. On web there's
// no process to ask, so the hooks that do the work report into here and
// `curatorStatus()` assembles the same shape out of it. Same interface either way;
// this store is just where the web half's answers live.
//
// Purely runtime (nothing persisted) — it's live status, not durable state, exactly
// like stores/sync.ts.

type CuratorState = {
  // When this instance's doc engine came up (for uptime). Null = not open.
  openedAt: number | null
  // The iroh-docs replica namespace this instance opened.
  namespace: string | null
  // Result of publishing the did:dht document ("ok …" / "failed: …").
  didDhtPublished: string | null
  // The doc's durable Sia snapshot (lib/docsMirror.ts): off | pushed | error.
  // Lives here on BOTH platforms — the snapshot is TS, running over whichever doc
  // engine is present, so `curatorStatus()` overlays these onto the native status
  // too rather than the Rust process reporting a mirror it doesn't run.
  mirrorState: string
  mirrorUrl: string | null
  mirrorError: string | null
  lastError: string | null
  // Whether this instance's doc holds what this identity has published.
  //
  // 'pending' until a boot establishes it, and on web that takes a read: the doc is a
  // fresh MemStore every session, so a doc nobody restored says this identity endorses
  // nothing, comments nothing and follows nobody. Loops that publish current state read
  // this before saying so on the network. 'unknown' is a snapshot that exists and could
  // not be reached, which retries; 'ready' covers both a restored doc and an identity
  // that has published no snapshot at all.
  docRestore: 'pending' | 'ready' | 'unknown'
  set: (p: Partial<Omit<CuratorState, 'set' | 'reset'>>) => void
  reset: () => void
}

const INITIAL = {
  openedAt: null,
  namespace: null,
  didDhtPublished: null,
  mirrorState: 'off',
  mirrorUrl: null,
  mirrorError: null,
  lastError: null,
  docRestore: 'pending' as const,
}

export const useCuratorStore = create<CuratorState>()((set) => ({
  ...INITIAL,
  set: (p) => set(p),
  reset: () => set(INITIAL),
}))
