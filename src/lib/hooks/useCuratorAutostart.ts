import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { startCurator } from '../curator'
import { inTauri } from '../openExternal'

// The Curator is part of the desktop app, not an opt-in: its iroh-docs replica is the
// app's data home (Slice B routes docs.ts through it), so it must be up whenever the
// app is. Start it automatically once connected (the AppKey is unlocked), rather than
// waiting for the Curate toggle. Idempotent on the Rust side — a repeat start
// (StrictMode double-mount, reconnect) returns the current status without rebinding.
// No-op on web, where there's no native process to run.
export function useCuratorAutostart() {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!inTauri() || !client || !storedKeyHex) return
    const { indexerURL } = useAuthStore.getState()
    startCurator(storedKeyHex, indexerURL).catch((e) =>
      console.warn('Curator autostart failed:', e),
    )
  }, [client, storedKeyHex])
}
