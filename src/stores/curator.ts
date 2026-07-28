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
  // Sia mirror lifecycle, mirroring the native Curator's vocabulary:
  // off | up-to-date | pushed | error | no-session.
  mirrorState: string
  mirrorUrl: string | null
  mirrorError: string | null
  lastError: string | null
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
}

export const useCuratorStore = create<CuratorState>()((set) => ({
  ...INITIAL,
  set: (p) => set(p),
  reset: () => set(INITIAL),
}))
