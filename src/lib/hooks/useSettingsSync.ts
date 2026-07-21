import type { Sdk } from '@siafoundation/sia-storage'
import { useEffect, useRef } from 'react'
import { decryptSettings, deriveSettingsKey } from '../../core/crypto'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import { useAuthStore } from '../../stores/auth'
import { readRecordFromSnapshot } from '../docsMirror'
import { flushSettingsMirror } from './useSettingsDocsMirror'

// The durable settings write is the Sia snapshot (useSettingsDocsMirror) now —
// these flushes delegate to it. Kept here so the existing callers keep their
// import site.
export async function flushPendingSettingsSave(): Promise<void> {
  await flushSettingsMirror()
}

// Await the durable settings write now, swallowing failures. Call after a
// mutation that should be durable before the operation reports done. Best-effort:
// on failure the mirror's stale fingerprint re-pushes next change/boot, so
// callers proceed rather than wedge.
export async function flushSettingsBestEffort(): Promise<void> {
  try {
    await flushPendingSettingsSave()
  } catch (e) {
    console.warn('Settings flush failed; will re-push next boot:', e)
  }
}

// Loads the user's settings on boot from the Sia snapshot (the canonical store,
// written by useSettingsDocsMirror). No atproto: settings are keyed on the Sia
// AppKey alone, so a session-less did:dht-native user rehydrates from Sia just
// the same.
export function useSettingsSync() {
  const sdk = useAuthStore((s) => s.sdk)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const settingsKeyRef = useRef<Uint8Array | null>(null)

  useEffect(() => {
    if (!sdk || !storedKeyHex) return
    if (useAuthStore.getState().settingsLoaded) return

    let cancelled = false
    ;(async () => {
      try {
        const appKeyBytes = Uint8Array.fromHex(storedKeyHex)
        const key = await deriveSettingsKey(appKeyBytes)
        if (cancelled) return
        settingsKeyRef.current = key

        if (useAuthStore.getState().settingsDirty) {
          // Local has unpushed mutations (crash mid-mirror last session). Local
          // is fresher — don't overwrite it; mark loaded and let the mirror's
          // boot catch-up (stale fingerprint) re-push.
          useAuthStore.getState().setSettingsLoaded(true)
          return
        }

        const snap = await readSettingsFromSnapshot(
          sdk,
          appKeyBytes,
          key,
        ).catch(() => null)
        if (cancelled) return
        if (snap) {
          useAuthStore
            .getState()
            .hydrateSettings(
              snap.myChannels,
              snap.subscriptions,
              snap.dismissedAutoWatch ?? [],
              snap.theme ?? useAuthStore.getState().theme,
              snap.follows ?? [],
              snap.handleFollows ?? [],
              snap.profile ?? null,
            )
        } else {
          // No snapshot yet — first user mutation creates it.
          useAuthStore.getState().setSettingsLoaded(true)
        }
      } catch (e) {
        if (cancelled) return
        console.warn('Settings load failed:', e)
        // Treat load failure as "no settings yet" rather than blocking — a
        // transient hiccup shouldn't wipe local state.
        useAuthStore.getState().setSettingsLoaded(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sdk, storedKeyHex])
}

// Read + decrypt settings/self straight from the latest Sia snapshot (the doc's
// durable projection), without the pin-core engine. Returns null if there's no
// snapshot, no settings entry, or a version mismatch.
async function readSettingsFromSnapshot(
  sdk: Sdk,
  appKeyBytes: Uint8Array,
  key: Uint8Array,
): Promise<DispatchSettings | null> {
  const bytes = await readRecordFromSnapshot(
    sdk,
    appKeyBytes,
    'settings',
    'self',
  )
  if (!bytes) return null
  const json = await decryptSettings(key, new TextDecoder().decode(bytes))
  const s = JSON.parse(json) as DispatchSettings
  return s.version === SETTINGS_VERSION ? s : null
}
