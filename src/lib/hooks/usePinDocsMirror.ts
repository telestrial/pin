import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { usePinStore } from '../../stores/pin'
import { snapshotToSia } from '../docsMirror'
import { syncPinRecords } from '../pinRecords'

// Keep the doc's pin records in step with what this identity holds.
//
// Same shape as the settings mirror, and for the same reason: the Zustand store is the
// local runtime (and gives an instant boot off its localStorage cache), while the doc
// record is the durable copy that travels between your devices and that the Curator
// can read. What changed is which of those is the RECORD — a pin is a decision you
// made, not a cache, so it can't only exist on the machine you happened to make it on.
//
// Reconciles rather than writing per mutation: `pinned` moves in four places (pin,
// unpin, the drift swap, repack's rewrite) and a diff covers all of them.
//
// Debounced and serialized, because a channel pin fans out one store change per item —
// an N-item channel would otherwise reconcile N times against the network.

const DEBOUNCE_MS = 1500

export function usePinDocsMirror() {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!client || !storedKeyHex) return

    let cancelled = false
    let saving = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const reconcile = async () => {
      saving = true
      try {
        const result = await syncPinRecords(
          storedKeyHex,
          usePinStore.getState().pinned,
        )
        if (cancelled) return
        // Only snapshot when the doc actually moved. The snapshot is a Sia upload;
        // paying for one when nothing changed would make every quiet pass expensive.
        if (result.written > 0 || result.deleted > 0) {
          await snapshotToSia(client, storedKeyHex)
        }
      } catch (e) {
        // The next change retries. A pin that failed to record is still held locally,
        // so nothing is lost yet — but it hasn't travelled, so say so.
        console.warn('pin docs-mirror failed (will retry):', e)
      } finally {
        saving = false
        if (pending && !cancelled) {
          pending = false
          schedule()
        }
      }
    }

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (saving) pending = true
        else void reconcile()
      }, DEBOUNCE_MS)
    }

    const unsub = usePinStore.subscribe((s, p) => {
      if (s.pinned !== p.pinned) schedule()
    })

    // Boot catch-up: records the pins this device already held before the doc knew
    // about them, and clears any whose pin is gone. Free when already in step — the
    // reconcile writes nothing.
    schedule()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [client, storedKeyHex])
}
