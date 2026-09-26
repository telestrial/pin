import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { useCuratorStore } from '../../stores/curator'
import { getRecord, openDocs } from '../docs'
import { hydrateFromSia } from '../docsMirror'
import { inTauri } from '../openExternal'
import { settleWithdrawals } from '../withdrawn'

// Put back what this instance's doc held last session.
//
// On web the doc is a fresh MemStore every session and the only thing that refilled it
// was two mirrors reading localStorage — settings, and pin endorsements via the pin
// catch-up. Everything else in the doc simply started empty: likes, reposts, comments,
// channel manifests, the crawl index, delivery marks.
//
// DESKTOP IS NOT EXEMPT, AND READING IT AS EXEMPT IS THE SAME CONFLATION ONE LAYER UP.
// This reported ready under Tauri without looking at anything, on the reasoning that a
// persistent store needs no restoring. True of a store that has been populated, and a
// durable store is not a populated one: a fresh install, or a second identity on an
// existing install, opens a redb that is EMPTY, because the namespace derives from the
// AppKey. Reporting ready over that releases the three loops that publish current state,
// and they do to the durable copy exactly what a tab did to it before the restore
// existed — identity republishes a directory carrying no endorsements, snapshot mirrors
// the empty doc and moves the pointer onto it.
//
// So the question belongs to the doc rather than to the platform. Asked as "does this
// doc hold this identity's settings": one record, written by nothing but the settings
// mirror, and the mirror cannot run before this settles (it waits on `settingsLoaded`,
// which waits on `docRestore`), so there is no circularity in reading it here. Asking
// `listAll` whether the doc is empty would NOT be safe — the instance loop is in the
// ungated group and registers this endpoint immediately, so an untouched doc answers
// non-empty within a second of boot.
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
    if (!client || !storedKeyHex) return

    let cancelled = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const attemptRestore = async () => {
      if (cancelled) return
      try {
        await openDocs(storedKeyHex)
        if (cancelled) return
        // A durable store that has already been populated has nothing to put back, and
        // reading the snapshot back into it every boot would churn the doc the snapshot
        // loop is fingerprinting. The settings record is what says it was populated.
        if (inTauri() && (await getRecord('settings', 'self'))) {
          if (cancelled) return
          useCuratorStore.getState().set({ docRestore: 'ready' })
          // Nothing read the snapshot, so nothing here forgot a withdrawal the snapshot
          // has caught up with. That is this pass's job instead. See `settleWithdrawals`.
          void settleWithdrawals()
          return
        }
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
