import type { Sdk } from '@siafoundation/sia-storage'
import { useEffect, useRef } from 'react'
import { decryptSettings, deriveSettingsKey } from '../../core/crypto'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import {
  loadSettingsRecord,
  saveSettingsRecord,
} from '../../core/settingsRecord'
import { useAuthStore } from '../../stores/auth'
import { useStorageActivityStore } from '../../stores/storageActivity'
import { readRecordFromSnapshot } from '../docsMirror'

// Wedge-guard: if an authenticated user's atproto agent never restores (OAuth
// failure) on a fresh origin with no cached channels, don't pin the UI on the
// "restoring…" gate forever. Proceed with (empty) local state after this.
const AGENT_WAIT_TIMEOUT_MS = 15_000

// Module-scope flush hook so non-React callers (e.g. the Sign Out button,
// channel mutations) can await any pending settings save before proceeding.
// Set by useSettingsSync on mount; cleared on unmount.
let activeFlush: (() => Promise<void>) | null = null

export async function flushPendingSettingsSave(): Promise<void> {
  if (activeFlush) await activeFlush()
}

// Await the durable settings write now, swallowing failures. Call after a
// myChannels/subscriptions mutation that should be durable before the operation
// reports done. With the PDS record this is a single sub-second putRecord (no
// debounce), so a channel-list change is durable on the PDS by the time the
// operation completes. Best-effort: on failure the settingsDirty bit re-pushes
// next boot, so callers proceed rather than wedging. No-op for just-reading
// users (no atproto session — nothing to sync to).
export async function flushSettingsBestEffort(): Promise<void> {
  try {
    await flushPendingSettingsSave()
  } catch (e) {
    console.warn('Settings flush failed; will re-push next boot:', e)
  }
}

// Mirrors the user's channels + subscriptions (and the channel keys inside
// them) to their PDS settings record — dev.sia.pin.settings/self, mutable in
// place. The single-record shape dissolves the Sia settings-object
// proliferation / convergence / ghost-channel bug class.
//
// Engages only with an atproto session; just-reading users stay localStorage-
// only. The record is encrypted under a key derived from the Sia AppKey (never
// shared, never the atproto identity) and fixed-pad so the public record leaks
// nothing about content or size.
export function useSettingsSync() {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const settingsLoaded = useAuthStore((s) => s.settingsLoaded)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const settingsKeyRef = useRef<Uint8Array | null>(null)

  // Load / migrate once the agent + AppKey are available.
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
          // Local has unpushed mutations (crash mid-save last session). Local
          // is fresher than the PDS — don't overwrite it. Grab the current CID
          // so the push can CAS, mark loaded; the save effect's needsPush
          // fires the actual write.
          const pds = await loadSettingsRecord(agent, key)
          if (cancelled) return
          useAuthStore.getState().setSettingsRecordCid(pds?.cid ?? null)
          useAuthStore.getState().setSettingsLoaded(true)
          return
        }

        // Read atproto (still the write target) and the Sia snapshot (the doc's
        // durable projection) in parallel; take whichever settings are fresher by
        // updatedAt. During dual-write atproto is awaited (fresher) so it keeps
        // winning — zero behavior change; the snapshot takes over only when
        // atproto is absent or older (i.e. once its write is dropped). The
        // snapshot read is cheap — a Sia download + decrypt, no pin-core engine.
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
        // transient PDS hiccup shouldn't wipe local state.
        useAuthStore.getState().setSettingsLoaded(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sdk, agent, storedKeyHex])

  // Save on change after load completes. Awaited (no debounce), serialized so
  // two writes never race.
  useEffect(() => {
    if (!agent || !settingsLoaded) return

    let saving = false
    let pending = false

    const initial = useAuthStore.getState()
    // needsPush: a dirty bit carried from a prior session that didn't commit,
    // OR no PDS record yet but local has state (first PDS write — e.g. a
    // just-reading user who just added atproto). Both want the same thing: a
    // save against current local state at startup.
    const needsPush =
      initial.settingsDirty ||
      (initial.settingsRecordCid === null &&
        (initial.myChannels.length > 0 ||
          initial.subscriptions.length > 0 ||
          initial.dismissedAutoWatch.length > 0 ||
          initial.follows.length > 0 ||
          initial.handleFollows.length > 0))
    let lastSerialized = needsPush ? '__push__' : serialize(initial)

    const runSave = async () => {
      let key = settingsKeyRef.current
      if (!key) {
        // Self-heal: the load effect may have skipped key derivation (e.g. an
        // already-loaded lurker who just added atproto).
        const hex = useAuthStore.getState().storedKeyHex
        if (!hex) return
        key = await deriveSettingsKey(Uint8Array.fromHex(hex))
        settingsKeyRef.current = key
      }

      const state = useAuthStore.getState()
      const serialized = serialize(state)
      if (serialized === lastSerialized) return
      lastSerialized = serialized

      saving = true
      useStorageActivityStore.getState().setSavingSettings(true)
      try {
        const settings: DispatchSettings = {
          version: SETTINGS_VERSION,
          myChannels: state.myChannels,
          subscriptions: state.subscriptions,
          dismissedAutoWatch: state.dismissedAutoWatch,
          theme: state.theme,
          follows: state.follows,
          handleFollows: state.handleFollows,
          updatedAt: new Date().toISOString(),
        }
        const cid = await saveSettingsRecord(
          agent,
          key,
          settings,
          useAuthStore.getState().settingsRecordCid,
        )
        useAuthStore.getState().setSettingsRecordCid(cid)
        // Caught up — but only if nothing changed during the write. If state
        // drifted, the next runSave clears dirty when it catches up.
        const after = useAuthStore.getState()
        if (serialize(after) === lastSerialized) {
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
          void runSave()
        }
      }
    }

    const trigger = () => {
      // Mark dirty before the write lands so a crash mid-write re-pushes next
      // boot instead of leaving the PDS stale.
      useAuthStore.getState().setSettingsDirty(true)
      if (saving) {
        pending = true
        return
      }
      void runSave()
    }

    const unsub = useAuthStore.subscribe((state, prev) => {
      if (
        state.myChannels === prev.myChannels &&
        state.subscriptions === prev.subscriptions &&
        state.dismissedAutoWatch === prev.dismissedAutoWatch &&
        state.theme === prev.theme &&
        state.follows === prev.follows &&
        state.handleFollows === prev.handleFollows
      ) {
        return
      }
      trigger()
    })

    if (needsPush) trigger()

    activeFlush = async () => {
      // Wait for any in-flight save, then save if anything is still pending.
      while (saving) await new Promise((r) => setTimeout(r, 50))
      const state = useAuthStore.getState()
      if (serialize(state) !== lastSerialized) {
        await runSave()
      }
    }

    return () => {
      activeFlush = null
      unsub()
    }
  }, [agent, settingsLoaded])
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

// Change-detection fingerprint of the synced slice. Takes the whole store
// state so adding a synced field only touches this function, not every call
// site.
function serialize(s: ReturnType<typeof useAuthStore.getState>): string {
  return JSON.stringify({
    myChannels: s.myChannels,
    subscriptions: s.subscriptions,
    dismissedAutoWatch: s.dismissedAutoWatch,
    theme: s.theme,
    follows: s.follows,
    handleFollows: s.handleFollows,
  })
}
