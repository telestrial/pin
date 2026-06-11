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

// Persist pending settings changes to Sia now, swallowing upload failures.
// Call after a myChannels/subscriptions mutation that should be durable
// before the operation reports done — otherwise the change only reaches Sia
// on the background debounce, and a quick reload/close rehydrates the stale
// settings (creating ghost channels / resurrecting removed subs). Best-
// effort: on failure the settingsDirty bit re-pushes next boot, so callers
// proceed rather than wedging.
export async function flushSettingsBestEffort(): Promise<void> {
  try {
    await flushPendingSettingsSave()
  } catch (e) {
    console.warn('Settings flush failed; will re-push next boot:', e)
  }
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
          if (useAuthStore.getState().settingsDirty) {
            // localStorage has mutations that didn't make it to Sia last
            // session (tab closed during the debounce or mid-upload). Local
            // is fresher than Sia by definition — don't overwrite. Capture
            // the objectID so the next save deletes the prior; Phase 2's
            // needsPush path will fire the save.
            useAuthStore.getState().setSettingsObjectID(result.objectID)
            useAuthStore.getState().setSettingsLoaded(true)
          } else {
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
          }
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
    // needsPush covers both: pre-feature migration AND a dirty bit carried
    // over from a prior session that didn't get to commit. Both want the
    // same thing — fire a save against current local state at startup.
    const needsPush = needsMigration || initialState.settingsDirty
    let lastSerialized = needsPush
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
        // Caught up — but only if nothing else changed during the upload.
        // If state drifted (a mutation while we were uploading), the next
        // runSave will clear dirty when it catches up.
        const after = useAuthStore.getState()
        if (
          serialize(after.myChannels, after.subscriptions) === lastSerialized
        ) {
          useAuthStore.getState().setSettingsDirty(false)
        }
      } catch (e) {
        console.warn('Settings save failed:', e)
        // Leave dirty=true; next mutation or next boot retries.
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
      // Mark dirty as soon as we know a save is needed — even before the
      // debounce fires. If the user closes the tab inside the debounce
      // window or mid-upload, the dirty bit survives in localStorage and
      // next boot re-pushes local state to Sia instead of overwriting it.
      useAuthStore.getState().setSettingsDirty(true)
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

    if (needsPush) schedule()

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
