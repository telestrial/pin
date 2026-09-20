import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { useCuratorStore } from '../../stores/curator'
import { openDocs } from '../docs'
import { hydrateFromSia } from '../docsMirror'
import { inTauri } from '../openExternal'

// Put back what this instance's doc held last session.
//
// On desktop there is nothing to do: the Curator keeps a redb store, so its doc is the
// one it had. On web the doc is a fresh MemStore every session and the only thing that
// refilled it was two mirrors reading localStorage — settings, and pin endorsements via
// the pin catch-up. Everything else in the doc simply started empty: likes, reposts,
// comments, channel manifests, the crawl index, delivery marks.
//
// That is a loss on its own, and worse than a loss for anything published as CURRENT
// STATE. The identity loop assembles a directory from the doc and a reader takes an
// absence for a withdrawal, so a reload republished every like and comment as taken
// back; the snapshot loop mirrors the doc it finds, so the durable copy followed.
//
// The restore is the recovery half. `docRestore` is the guard half — see
// `useCuratorLoops`, which holds the publishing loops until this settles.

// Retry spacing for a snapshot that exists and would not read. Backs off to a minute so
// a long outage is not a poll, and never stops: the alternative to eventually reading is
// an instance that never publishes again.
const RETRY_MS = [2_000, 5_000, 15_000, 60_000] as const

export function useDocRestore() {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    // A persistent store needs no restoring, and writing every record back into it
    // would churn the doc the snapshot loop is fingerprinting.
    if (inTauri()) {
      useCuratorStore.getState().set({ docRestore: 'ready' })
      return
    }
    if (!client || !storedKeyHex) return

    let cancelled = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const attemptRestore = async () => {
      if (cancelled) return
      try {
        await openDocs(storedKeyHex)
        if (cancelled) return
        const outcome = await hydrateFromSia(
          client,
          Uint8Array.fromHex(storedKeyHex),
        )
        if (cancelled) return
        // An identity that has published no snapshot has nothing to put back, which is
        // as restored as it can be — a brand-new account, and the state every account
        // starts in.
        if (outcome.kind !== 'unknown') {
          useCuratorStore.getState().set({ docRestore: 'ready' })
          return
        }
        useCuratorStore
          .getState()
          .set({ docRestore: 'unknown', lastError: outcome.error })
      } catch (e) {
        if (cancelled) return
        useCuratorStore
          .getState()
          .set({ docRestore: 'unknown', lastError: String(e) })
      }
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]
      attempt += 1
      timer = setTimeout(attemptRestore, wait)
    }

    void attemptRestore()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [client, storedKeyHex])
}
