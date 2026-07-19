import { useEffect } from 'react'
import { deriveSettingsKey, encryptSettings } from '../../core/crypto'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import { useAuthStore } from '../../stores/auth'
import { useStorageActivityStore } from '../../stores/storageActivity'
import { openDocs, putRecord } from '../docs'
import { snapshotToSia } from '../docsMirror'

// The user's settings mirrored into iroh-docs + Sia — the CANONICAL settings
// write (Phase C step 4b dropped the atproto settings record). Everything the
// user holds — channels + their keys, subscriptions, follows / handle-follows,
// profile, theme, auto-Watch tombstones — lives here, encrypted under a key
// derived from the Sia AppKey (never shared, never the atproto identity), and
// made durable on Sia via the snapshot. Runs for every Sia user, so just-reading
// users get durable settings too (they had none under the atproto-only write).
//
// Reliability model: a localStorage FINGERPRINT records the settings content last
// SUCCESSFULLY mirrored. The mirror writes only when the current content differs,
// and advances the fingerprint only on success. So a failed write retries on the
// next change AND on the next boot (self-healing catch-up) — no change is silently
// lost. A matching fingerprint short-circuits BEFORE openDocs, so pin-core's wasm
// + relay stay unloaded when there's nothing new.

const DEBOUNCE_MS = 2000
const FINGERPRINT_KEY = 'pin:docsnapshot:settingsFingerprint'

// Module-scope flush so non-React callers (channel mutations, etc.) can await the
// durable settings write before proceeding. Set by the hook on mount.
let activeMirrorFlush: (() => Promise<void>) | null = null

// Await the durable settings write now (best-effort) — the replacement for the
// old atproto flush. Resolves once the current settings are mirrored to Sia (or,
// on failure, a retry is left armed via the stale fingerprint).
export async function flushSettingsMirror(): Promise<void> {
  if (activeMirrorFlush) await activeMirrorFlush()
}

function settingsFingerprint(): string {
  const s = useAuthStore.getState()
  return JSON.stringify({
    myChannels: s.myChannels,
    subscriptions: s.subscriptions,
    dismissedAutoWatch: s.dismissedAutoWatch,
    theme: s.theme,
    follows: s.follows,
    handleFollows: s.handleFollows,
    profile: s.profile,
  })
}

function readFingerprint(): string | null {
  try {
    return localStorage.getItem(FINGERPRINT_KEY)
  } catch {
    return null
  }
}

function writeFingerprint(fp: string): void {
  try {
    localStorage.setItem(FINGERPRINT_KEY, fp)
  } catch {
    // localStorage unavailable — the fingerprint is an optimization; without it
    // the mirror just runs every boot/change (correct, only less cheap).
  }
}

export function useSettingsDocsMirror() {
  const sdk = useAuthStore((s) => s.sdk)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!sdk || !storedKeyHex) return

    const appKeyBytes = Uint8Array.fromHex(storedKeyHex)
    let cancelled = false
    let opened = false
    let saving = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const ensureOpen = async () => {
      if (!opened) {
        await openDocs(storedKeyHex)
        opened = true
      }
    }

    const mirror = async () => {
      const fp = settingsFingerprint()
      // Already mirrored this exact content — skip before touching pin-core.
      if (fp === readFingerprint()) return
      saving = true
      useStorageActivityStore.getState().setSavingSettings(true)
      try {
        await ensureOpen()
        if (cancelled) return
        const state = useAuthStore.getState()
        const settings: DispatchSettings = {
          version: SETTINGS_VERSION,
          myChannels: state.myChannels,
          subscriptions: state.subscriptions,
          dismissedAutoWatch: state.dismissedAutoWatch,
          theme: state.theme,
          follows: state.follows,
          handleFollows: state.handleFollows,
          profile: state.profile,
          updatedAt: new Date().toISOString(),
        }
        const key = await deriveSettingsKey(appKeyBytes)
        const enc = await encryptSettings(key, JSON.stringify(settings))
        await putRecord('settings', 'self', new TextEncoder().encode(enc))
        await snapshotToSia(sdk, appKeyBytes)
        // Only advance the fingerprint on full success — a failure leaves it
        // stale so the next change/boot retries (no silent loss).
        writeFingerprint(fp)
      } catch (e) {
        console.warn('settings mirror failed (will retry):', e)
      } finally {
        saving = false
        useStorageActivityStore.getState().setSavingSettings(false)
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
        else void mirror()
      }, DEBOUNCE_MS)
    }

    const unsub = useAuthStore.subscribe((s, p) => {
      if (
        s.myChannels === p.myChannels &&
        s.subscriptions === p.subscriptions &&
        s.dismissedAutoWatch === p.dismissedAutoWatch &&
        s.theme === p.theme &&
        s.follows === p.follows &&
        s.handleFollows === p.handleFollows &&
        s.profile === p.profile
      ) {
        return
      }
      schedule()
    })

    // Boot catch-up: if local settings differ from what we last mirrored (a
    // failed write last session, first run, or new fields added since), re-mirror.
    // mirror() self-skips when the fingerprint already matches, so it's free when
    // up to date.
    if (settingsFingerprint() !== readFingerprint()) schedule()

    // Flush contract (durable-when-done): await any in-flight mirror, then mirror
    // once if still stale. Callers awaiting this get the current settings durable
    // on Sia — the replacement for the dropped atproto flush.
    activeMirrorFlush = async () => {
      while (saving) await new Promise((r) => setTimeout(r, 50))
      if (settingsFingerprint() !== readFingerprint()) await mirror()
    }

    return () => {
      cancelled = true
      activeMirrorFlush = null
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [sdk, storedKeyHex])
}
