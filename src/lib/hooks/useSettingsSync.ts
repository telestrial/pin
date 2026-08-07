import { useEffect, useRef } from 'react'
import { decryptSettings, deriveSettingsKey } from '../../core/crypto'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import type { SiaClient } from '../../core/siaClient'
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
// How long between attempts to recover a restore's settings. The durable pointer is
// a pkarr record, and a browser resolves those through public relays that lag — so a
// single miss says nothing, and giving up says something false.
const RECOVERY_RETRY_MS = 10_000

export function useSettingsSync() {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const settingsKeyRef = useRef<Uint8Array | null>(null)

  useEffect(() => {
    if (!client || !storedKeyHex) return
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
          useAuthStore.getState().setSettingsOrigin('loaded')
          useAuthStore.getState().setSettingsLoaded(true)
          return
        }

        // A brand-new account (this session created it) has nothing to recover, so
        // skip the DHT locator resolve. Its local state is authoritative by
        // definition — there is no durable copy it could be contradicting.
        if (useAuthStore.getState().justCreatedAccount) {
          useAuthStore.getState().setSettingsOrigin('created')
          useAuthStore.getState().setSettingsLoaded(true)
          return
        }

        // A RESTORE. From here on, failing to find settings must never be read as
        // "there aren't any": a resolve that comes back empty is indistinguishable
        // from one that couldn't reach the network, and the durable pointer lives on
        // pkarr, which a browser reaches through relays that lag. Concluding
        // emptiness here is what lets the naming gate fire and the mirror publish an
        // empty settings record over a real one — a second device silently erasing
        // the account's channels.
        //
        // So: keep trying, and until it succeeds leave the origin 'unknown', which
        // is what stops anything being written. The doc-sync overlay can also finish
        // this for us by handing over a peer's copy.
        useAuthStore.getState().setSettingsLoaded(true)
        for (let attempt = 0; !cancelled; attempt++) {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, RECOVERY_RETRY_MS))
            if (cancelled) return
            // A peer's synced settings may have arrived meanwhile — that counts.
            if (useAuthStore.getState().settingsOrigin !== 'unknown') return
          }
          const snap = await readSettingsFromSnapshot(
            client,
            appKeyBytes,
            key,
            true,
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
            return
          }
          console.warn(
            `Settings not recovered yet (attempt ${attempt + 1}); retrying. Nothing will be published until they are.`,
          )
        }
      } catch (e) {
        if (cancelled) return
        // Origin stays 'unknown', which is the point: the app renders, but nothing
        // it holds may be written anywhere.
        console.warn('Settings load failed:', e)
        useAuthStore.getState().setSettingsLoaded(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client, storedKeyHex])
}

// Read + decrypt settings/self straight from the latest Sia snapshot (the doc's
// durable projection), without the pin-core engine. Returns null if there's no
// snapshot, no settings entry, or a version mismatch.
async function readSettingsFromSnapshot(
  client: SiaClient,
  appKeyBytes: Uint8Array,
  key: Uint8Array,
  recoverViaLocator: boolean,
): Promise<DispatchSettings | null> {
  const bytes = await readRecordFromSnapshot(
    client,
    appKeyBytes,
    'settings',
    'self',
    recoverViaLocator,
  )
  if (!bytes) return null
  const json = await decryptSettings(key, new TextDecoder().decode(bytes))
  const s = JSON.parse(json) as DispatchSettings
  return s.version === SETTINGS_VERSION ? s : null
}
