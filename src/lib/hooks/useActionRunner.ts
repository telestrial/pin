import { useEffect } from 'react'
import {
  ACTION_KINDS,
  type Action,
  useActionStore,
} from '../../stores/actionQueue'
import { useAuthStore } from '../../stores/auth'
import { usePinStore } from '../../stores/pin'
import { useToastStore } from '../../stores/toast'
import { loadPersistedActions } from '../actionQueuePersist'
import {
  type DeleteObjectsContext,
  runDeleteObjects,
} from '../actions/deleteObjects'
import {
  type PublishContext,
  runPublish,
  SilentActionError,
} from '../actions/publish'

const SUCCESS_AUTO_REMOVE_MS = 4000

// Module-level guard so React StrictMode's double-mount (and any remount)
// doesn't re-read IDB and double-insert actions.
let hydrated = false

// Re-enqueue actions that were persisted but never finished — a tab closed
// mid-run, a crash, etc. Persisted actions are only ever 'pending' or 'failed'
// (in-flight states are coerced to 'pending' on write), so both resume
// correctly: pending re-runs through the runner — fast-pathing past the upload
// if it carries a checkpoint — and failed waits for a retry. Records without a
// recognized kind (legacy upload-queue tasks) are dropped. Runs once on app
// start, before/independent of the SDK being ready.
export function useActionQueueHydration() {
  useEffect(() => {
    if (hydrated) return
    hydrated = true
    loadPersistedActions()
      .then((persisted) => {
        const valid = persisted.filter((a) =>
          (ACTION_KINDS as readonly string[]).includes(a?.kind),
        )
        if (valid.length === 0) return
        useActionStore.setState((s) => {
          const existing = new Set(s.actions.map((a) => a.id))
          const restored = valid.filter((a) => !existing.has(a.id))
          if (restored.length === 0) return s
          return { actions: [...restored, ...s.actions] }
        })
      })
      .catch(() => {
        // best-effort; a failed restore just means nothing to resume
      })
  }, [])
}

export function useActionRunner() {
  const sdk = useAuthStore((s) => s.sdk)

  useEffect(() => {
    // Library publishes only need the Sia SDK; channel publishes need an agent
    // too, checked inside the handler so a missing agent fails just that action
    // instead of silently parking the whole journal.
    if (!sdk) return
    let running = false

    const processNext = async () => {
      if (running) return
      const action = useActionStore
        .getState()
        .actions.find((a) => a.state === 'pending')
      if (!action) return
      running = true
      try {
        await runOne(action)
      } finally {
        running = false
        processNext()
      }
    }

    // Dispatch to the per-kind handler. The handler does the work and updates
    // progress/phase/ledger through id-bound mutators; it throws to fail.
    const dispatch = (action: Action): Promise<void> => {
      switch (action.kind) {
        case 'publish': {
          const store = useActionStore.getState()
          const ctx: PublishContext = {
            sdk,
            setPhase: (phase, progress) =>
              store.setPhase(action.id, phase, progress),
            setProgress: (progress) => store.setProgress(action.id, progress),
            checkpoint: (ref) => store.checkpoint(action.id, ref),
            markPublished: (channelID) =>
              store.markChannelPublished(action.id, channelID),
          }
          return runPublish(action, ctx)
        }
        case 'delete-objects': {
          const store = useActionStore.getState()
          const ctx: DeleteObjectsContext = {
            sdk,
            markDone: (key) => store.markObjectDeleted(action.id, key),
          }
          return runDeleteObjects(action, ctx)
        }
      }
    }

    const runOne = async (action: Action) => {
      const store = useActionStore.getState()
      const toast = useToastStore.getState()
      store.setState(action.id, 'running', undefined)
      try {
        await dispatch(action)
        store.setProgress(action.id, 100)
        store.setState(action.id, 'success', undefined)
        if (!action.silent)
          toast.addToast(`${action.successLabel} “${action.title}”`)
        // A completed byte reclaim changed Sia storage — refresh the meter.
        if (action.kind === 'delete-objects') {
          usePinStore.getState().refreshAccount(sdk)
        }
        setTimeout(() => {
          useActionStore.getState().remove(action.id)
        }, SUCCESS_AUTO_REMOVE_MS)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed'
        store.setState(action.id, 'failed', msg)
        // Background actions (silent) and guard failures (SilentActionError)
        // already surface in the in-flight row; don't double-signal with a toast.
        if (!action.silent && !(e instanceof SilentActionError)) {
          toast.addToast(`${action.failLabel} failed: ${msg}`)
        }
      }
    }

    const unsub = useActionStore.subscribe(() => {
      processNext()
    })

    processNext()

    return unsub
  }, [sdk])
}
