import { useEffect } from 'react'
import {
  type DispatchSettings,
  loadSettings,
  SETTINGS_VERSION,
  saveSettings,
} from '../core/settings'
import { useAuthStore } from '../stores/auth'
import { useStorageActivityStore } from '../stores/storageActivity'

const SAVE_DEBOUNCE_MS = 1500

// Module-scope flush hook so non-React callers (e.g. the Sign Out button)
// can wait for any pending settings save to complete before tearing down.
// Set by useSettingsSync on mount; cleared on unmount.
let activeFlush: (() => Promise<void>) | null = null

export async function flushPendingSettingsSave(): Promise<void> {
  if (activeFlush) await activeFlush()
}

// Loads the user's settings (myChannels + subscriptions) from Sia after
// auth lands, and keeps them mirrored back to Sia whenever they change.
//
// Trust model: the Sia AppKey already encrypts the object at rest, so the
// JSON inside is plaintext from the user's perspective. Anyone with the
// recovery phrase has full access — same trust as the localStorage path.
export function useSettingsSync() {
  const sdk = useAuthStore((s) => s.sdk)
  const settingsLoaded = useAuthStore((s) => s.settingsLoaded)

  // Phase 1: load on first sdk availability.
  useEffect(() => {
    if (!sdk) return
    if (useAuthStore.getState().settingsLoaded) return

    let cancelled = false
    ;(async () => {
      try {
        const result = await loadSettings(sdk)
        if (cancelled) return
        if (result) {
          // Server-side settings win on first hydrate after a fresh origin.
          // Local zustand snapshot may be empty (new origin) or stale (old
          // device that hadn't seen recent edits) — either way, Sia is the
          // source of truth across origins.
          useAuthStore
            .getState()
            .hydrateSettings(
              result.settings.myChannels,
              result.settings.subscriptions,
              result.objectID,
            )
        } else {
          // No settings object yet. Proceed with whatever's in localStorage;
          // first user mutation will create the settings object.
          useAuthStore.getState().setSettingsLoaded(true)
        }
      } catch (e) {
        if (cancelled) return
        console.warn('Settings load failed:', e)
        // Treat load failure as "no settings yet" rather than blocking. We
        // don't want a transient indexer hiccup to wipe local state.
        useAuthStore.getState().setSettingsLoaded(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sdk])

  // Phase 2: subscribe to changes after load completes; debounced auto-save.
  useEffect(() => {
    if (!sdk || !settingsLoaded) return

    let timer: ReturnType<typeof setTimeout> | null = null
    let saving = false
    let pending = false
    // Pre-feature snapshot has local data but no settingsObjectID — set
    // lastSerialized to a sentinel so the post-mount migration save below
    // diverges from current state and uploads what's in localStorage.
    const initialState = useAuthStore.getState()
    const needsMigration =
      initialState.settingsObjectID === null &&
      (initialState.myChannels.length > 0 ||
        initialState.subscriptions.length > 0)
    let lastSerialized = needsMigration
      ? '__migrate__'
      : serialize(initialState.myChannels, initialState.subscriptions)

    const runSave = async () => {
      const state = useAuthStore.getState()
      const serialized = serialize(state.myChannels, state.subscriptions)
      if (serialized === lastSerialized) return
      lastSerialized = serialized

      saving = true
      useStorageActivityStore.getState().setSavingSettings(true)
      try {
        const settings: DispatchSettings = {
          version: SETTINGS_VERSION,
          myChannels: state.myChannels,
          subscriptions: state.subscriptions,
          updatedAt: new Date().toISOString(),
        }
        const newID = await saveSettings(sdk, settings, state.settingsObjectID)
        useAuthStore.getState().setSettingsObjectID(newID)
      } catch (e) {
        console.warn('Settings save failed:', e)
      } finally {
        saving = false
        useStorageActivityStore.getState().setSavingSettings(false)
        if (pending) {
          pending = false
          schedule()
        }
      }
    }

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (saving) {
          pending = true
          return
        }
        runSave()
      }, SAVE_DEBOUNCE_MS)
    }

    const unsub = useAuthStore.subscribe((state, prev) => {
      if (
        state.myChannels === prev.myChannels &&
        state.subscriptions === prev.subscriptions
      ) {
        return
      }
      schedule()
    })

    if (needsMigration) schedule()

    activeFlush = async () => {
      // Cancel any debounced timer; we want to flush NOW.
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // Wait for any in-flight save to finish.
      while (saving) await new Promise((r) => setTimeout(r, 50))
      // Save if anything is still dirty.
      const state = useAuthStore.getState()
      if (
        serialize(state.myChannels, state.subscriptions) !== lastSerialized
      ) {
        await runSave()
      }
    }

    return () => {
      activeFlush = null
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [sdk, settingsLoaded])
}

function serialize(
  myChannels: ReturnType<typeof useAuthStore.getState>['myChannels'],
  subscriptions: ReturnType<typeof useAuthStore.getState>['subscriptions'],
): string {
  return JSON.stringify({ myChannels, subscriptions })
}
