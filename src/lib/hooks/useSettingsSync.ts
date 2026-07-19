import type { Sdk } from '@siafoundation/sia-storage'
import { useEffect, useRef } from 'react'
import { decryptSettings, deriveSettingsKey } from '../../core/crypto'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import { loadSettingsRecord } from '../../core/settingsRecord'
import { useAuthStore } from '../../stores/auth'
import { readRecordFromSnapshot } from '../docsMirror'
import { flushSettingsMirror } from './useSettingsDocsMirror'

// Wedge-guard: if an authenticated user's atproto agent never restores (OAuth
// failure) on a fresh origin with no cached channels, don't pin the UI on the
// "restoring…" gate forever. Proceed with (empty) local state after this.
const AGENT_WAIT_TIMEOUT_MS = 15_000

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

// Loads the user's settings on boot. The canonical WRITE is the Sia snapshot
// (useSettingsDocsMirror); this hook only reads. Freshest-wins across the Sia
// snapshot and the (legacy, now write-dropped) atproto record — so the snapshot
// wins the moment atproto goes stale, with the atproto read kept only as
// transition safety until the session teardown removes it.
export function useSettingsSync() {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const settingsKeyRef = useRef<Uint8Array | null>(null)

  useEffect(() => {
    if (!sdk || !storedKeyHex) return
    if (useAuthStore.getState().settingsLoaded) return

    if (!agent) {
      // No atproto session. Distinguish "just reading, no atproto ever"
      // (proceed localStorage-only) from "authenticated, agent still booting"
      // (wait — the effect re-runs when atprotoAgent lands) via the persisted
      // DID. The timeout keeps a fresh-origin user off the loading gate if the
      // agent never restores.
      if (!useAuthStore.getState().atprotoDID) {
        useAuthStore.getState().setSettingsLoaded(true)
        return
      }
      const t = setTimeout(() => {
        if (!useAuthStore.getState().settingsLoaded) {
          useAuthStore.getState().setSettingsLoaded(true)
        }
      }, AGENT_WAIT_TIMEOUT_MS)
      return () => clearTimeout(t)
    }

    let cancelled = false
    ;(async () => {
      try {
        const key = await deriveSettingsKey(Uint8Array.fromHex(storedKeyHex))
        if (cancelled) return
        settingsKeyRef.current = key

        if (useAuthStore.getState().settingsDirty) {
          // Local has unpushed mutations (crash mid-mirror last session). Local
          // is fresher — don't overwrite it; mark loaded and let the mirror's
          // boot catch-up (stale fingerprint) re-push.
          const pds = await loadSettingsRecord(agent, key)
          if (cancelled) return
          useAuthStore.getState().setSettingsRecordCid(pds?.cid ?? null)
          useAuthStore.getState().setSettingsLoaded(true)
          return
        }

        // Read the Sia snapshot (canonical) and the legacy atproto record in
        // parallel; take whichever is fresher by updatedAt. The atproto write is
        // dropped, so it only ever loses once the snapshot moves ahead — the read
        // is pure transition safety until the session teardown.
        const appKeyBytes = Uint8Array.fromHex(storedKeyHex)
        const [atp, snap] = await Promise.all([
          loadSettingsRecord(agent, key).catch(() => null),
          readSettingsFromSnapshot(sdk, appKeyBytes, key).catch(() => null),
        ])
        if (cancelled) return
        const chosen = freshestSettings(atp?.settings ?? null, snap)
        if (chosen) {
          useAuthStore
            .getState()
            .hydrateSettings(
              chosen.myChannels,
              chosen.subscriptions,
              chosen.dismissedAutoWatch ?? [],
              chosen.theme ?? useAuthStore.getState().theme,
              chosen.follows ?? [],
              chosen.handleFollows ?? [],
              chosen.profile ?? null,
              atp?.cid ?? null,
            )
        } else {
          // Nothing anywhere — first user mutation creates the record.
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
  }, [sdk, agent, storedKeyHex])
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

// The fresher of two settings by updatedAt (ISO-8601, lexicographic = chrono).
function freshestSettings(
  a: DispatchSettings | null,
  b: DispatchSettings | null,
): DispatchSettings | null {
  if (!a) return b
  if (!b) return a
  return (a.updatedAt ?? '') >= (b.updatedAt ?? '') ? a : b
}
