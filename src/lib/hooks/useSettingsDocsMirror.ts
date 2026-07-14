import { useEffect } from 'react'
import { deriveSettingsKey, encryptSettings } from '../../core/crypto'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import { useAuthStore } from '../../stores/auth'
import { openDocs, putRecord } from '../docs'
import { snapshotToSia } from '../docsMirror'

// Phase C — mirror the user's settings into iroh-docs + Sia, alongside the atproto
// settings record. Increment 1 made this a best-effort shadow; increment 4(a)
// HARDENS it to atproto-write reliability, because it's about to become a (or the)
// source of truth once the atproto write is dropped in 4(b).
//
// Reliability model: a localStorage FINGERPRINT records the settings content last
// SUCCESSFULLY mirrored. The mirror only writes when the current content differs
// from the fingerprint, and only advances the fingerprint on success. So:
//   - a failed write leaves the fingerprint stale -> it retries on the next change
//     AND on the next boot (self-healing boot catch-up), so no change is silently
//     lost even without an atproto backstop;
//   - a matching fingerprint short-circuits BEFORE openDocs, so pin-core's wasm +
//     relay stay unloaded when there's nothing new to mirror (lazy cost preserved).
//
// atproto is still the source of truth through 4(a) — this is purely making the
// doc/Sia write trustworthy before 4(b) relies on it.

const DEBOUNCE_MS = 2000
const FINGERPRINT_KEY = 'pin:docsnapshot:settingsFingerprint'

function settingsFingerprint(): string {
  const s = useAuthStore.getState()
  return JSON.stringify({
    myChannels: s.myChannels,
    subscriptions: s.subscriptions,
    dismissedAutoWatch: s.dismissedAutoWatch,
    theme: s.theme,
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
        console.warn('settings docs-mirror failed (will retry):', e)
      } finally {
        saving = false
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
        s.theme === p.theme
      ) {
        return
      }
      schedule()
    })

    // Boot catch-up: if local settings differ from what we last mirrored (a
    // failed write last session, or first run), re-mirror. mirror() self-skips
    // when the fingerprint already matches, so this is free when up to date.
    if (settingsFingerprint() !== readFingerprint()) schedule()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [sdk, storedKeyHex])
}
