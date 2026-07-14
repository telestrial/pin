import { useEffect } from 'react'
import { deriveSettingsKey, encryptSettings } from '../../core/crypto'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import { useAuthStore } from '../../stores/auth'
import { openDocs, putRecord } from '../docs'
import { snapshotToSia } from '../docsMirror'

// Phase C, increment 1 — DUAL-WRITE settings into iroh-docs + Sia mirror,
// alongside the atproto settings record (which stays the source of truth). This
// hook is deliberately SEPARATE from useSettingsSync and touches nothing it does:
// it just shadows the same store slice into the doc engine so iroh-docs gets
// populated for real, end to end, at zero risk to the working atproto path. Later
// increments flip reads onto the doc, then drop the atproto write.
//
// It runs for anyone with a Sia AppKey — including just-reading users (no atproto
// session), who thereby get durable settings via Sia they don't have today.
//
// Cost is deferred: pin-core's wasm + the iroh relay bind happen lazily on the
// FIRST settings change (openDocs inside the mirror), so a session that never
// touches settings never loads any of it.

const DEBOUNCE_MS = 2000

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
      } catch (e) {
        // Best-effort: atproto is still the source of truth. A failed mirror
        // just leaves the doc/Sia copy behind; the next change re-mirrors.
        console.warn('settings docs-mirror failed:', e)
      } finally {
        saving = false
        if (pending && !cancelled) {
          pending = false
          void mirror()
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

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [sdk, storedKeyHex])
}
