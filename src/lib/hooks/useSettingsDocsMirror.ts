import { useEffect } from 'react'
import {
  decryptSettings,
  deriveSettingsKey,
  encryptSettings,
} from '../../core/crypto'
import type { ProfileRecord } from '../../core/profile'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import type {
  FollowEdge,
  OwnedChannel,
  SubscriptionRef,
  ThemeMode,
} from '../../core/types'
import { useAuthStore } from '../../stores/auth'
import { useCuratorStore } from '../../stores/curator'
import { useStorageActivityStore } from '../../stores/storageActivity'
import {
  getRecord,
  isRemoteChange,
  openDocs,
  putRecord,
  subscribeDocChanges,
} from '../docs'
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

// Slice 2a — the READ side. This hook also reflects a peer's freshly-SYNCED settings
// back into the store, so a change on one of your devices shows up on another. iroh-
// docs keeps the LWW-newest `settings/self` (single author, single key), so a replica
// value that DIFFERS from our last-mirrored content IS a newer peer write — no clock/
// updatedAt comparison needed. Guards keep it out of the catastrophe class: apply only
// when (a) boot is done, (b) our local state is fully mirrored — no unsynced edit to
// clobber, (c) the replica value decrypts + version-matches (never apply garbage),
// (d) it actually differs from what we hold. The Sia snapshot stays the untouched
// availability failsafe/floor (the WRITE side below is unchanged); this is a live
// overlay on top of it, never a replacement.

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

// The settings-relevant fields, in one shape so the WRITE fingerprint (store state)
// and the READ overlay (a decrypted peer settings record) compare identically.
export type SettingsFields = {
  myChannels: OwnedChannel[]
  subscriptions: SubscriptionRef[]
  dismissedAutoWatch: string[]
  theme: ThemeMode
  follows: FollowEdge[]
  handleFollows: string[]
  profile: ProfileRecord | null
}

export function fingerprintOf(f: SettingsFields): string {
  return JSON.stringify({
    myChannels: f.myChannels,
    subscriptions: f.subscriptions,
    dismissedAutoWatch: f.dismissedAutoWatch,
    theme: f.theme,
    follows: f.follows,
    handleFollows: f.handleFollows,
    profile: f.profile,
  })
}

function settingsFingerprint(): string {
  return fingerprintOf(useAuthStore.getState())
}

/** Decide whether a peer's decrypted settings (synced into the replica) should be
 *  applied over what we hold — the catastrophe-relevant guards, extracted pure so
 *  they're unit-tested. Returns the fields to apply, or null to skip. Skips when:
 *  our local state isn't fully mirrored (an unsynced edit we must not clobber); the
 *  record's version doesn't match (never apply what we can't trust); or the content
 *  equals what we already hold (no-op). `defaultTheme` fills an omitted (back-compat)
 *  theme, matching hydrateSettings. NOTE: garbage/undecryptable input never reaches
 *  here — the caller bails on decrypt failure before calling this. */
export function decidePeerSettings(
  peer: DispatchSettings,
  current: SettingsFields,
  mirrorClean: boolean,
  defaultTheme: ThemeMode,
): SettingsFields | null {
  if (!mirrorClean) return null
  if (peer.version !== SETTINGS_VERSION) return null
  const next: SettingsFields = {
    myChannels: peer.myChannels,
    subscriptions: peer.subscriptions,
    dismissedAutoWatch: peer.dismissedAutoWatch ?? [],
    theme: peer.theme ?? defaultTheme,
    follows: peer.follows ?? [],
    handleFollows: peer.handleFollows ?? [],
    profile: peer.profile ?? null,
  }
  if (fingerprintOf(next) === fingerprintOf(current)) return null
  return next
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
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!client || !storedKeyHex) return

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
        const pointer = await snapshotToSia(client, storedKeyHex)
        // Only advance the fingerprint on full success — a failure leaves it
        // stale so the next change/boot retries (no silent loss).
        writeFingerprint(fp)
        // Report to the Curate page. This snapshot IS the doc's Sia mirror on both
        // platforms — it took over the job the Curator's repo-CAR mirror had before
        // the iroh-docs cutover, and added the pkarr locator that one never had.
        useCuratorStore.getState().set({
          mirrorState: 'pushed',
          mirrorUrl: pointer.url,
          mirrorError: null,
        })
      } catch (e) {
        console.warn('settings mirror failed (will retry):', e)
        useCuratorStore
          .getState()
          .set({ mirrorState: 'error', mirrorError: String(e) })
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

    // READ overlay: reflect a peer's freshly-synced settings into the store.
    let overlayBusy = false
    const applyPeerSettingsIfNewer = async () => {
      if (overlayBusy) return
      overlayBusy = true
      try {
        if (!useAuthStore.getState().settingsLoaded) return
        // Only reflect peer state when OUR local state is fully mirrored — a
        // mismatch means an unsynced local edit we must not clobber (the mirror
        // will push it, then this resumes). This is also the wipe guard: we never
        // overwrite pending local work.
        if (settingsFingerprint() !== readFingerprint()) return

        await ensureOpen()
        if (cancelled) return
        const raw = await getRecord('settings', 'self')
        if (!raw) return

        // Never apply garbage: bail on any decrypt / parse / version mismatch.
        let peer: DispatchSettings
        try {
          const key = await deriveSettingsKey(appKeyBytes)
          peer = JSON.parse(
            await decryptSettings(key, new TextDecoder().decode(raw)),
          ) as DispatchSettings
        } catch {
          return
        }
        // The guarded decision (mirror-clean / version / differs) lives in a pure,
        // unit-tested function. A differing value ⟹ (by LWW-newest) a newer peer write.
        const s = useAuthStore.getState()
        const next = decidePeerSettings(
          peer,
          s,
          settingsFingerprint() === readFingerprint(),
          s.theme,
        )
        if (!next || cancelled) return
        useAuthStore
          .getState()
          .hydrateSettings(
            next.myChannels,
            next.subscriptions,
            next.dismissedAutoWatch,
            next.theme,
            next.follows,
            next.handleFollows,
            next.profile,
          )
        // Mark this content as mirrored so the WRITE side (which the hydrate's store
        // change just triggered) short-circuits instead of bouncing it back out.
        writeFingerprint(settingsFingerprint())
      } catch {
        // Transient (engine mid-open, IPC hiccup) — try again next tick.
      } finally {
        overlayBusy = false
      }
    }
    // Driven by the doc's change feed rather than a timer: the engine says when
    // `settings/self` moved, and we re-read it. `isRemoteChange` filters out our own
    // writes (which would bounce straight back out); an empty collection is a
    // stream-level event (notably content-ready, whose value may be the settings blob
    // finishing its download) so it counts too.
    const unsubChanges = subscribeDocChanges(({ collection, kind }) => {
      if (!isRemoteChange(kind)) return
      if (collection && collection !== 'settings') return
      void applyPeerSettingsIfNewer()
    })
    // Push for speed, pull for truth: read once on mount. A change that landed while
    // this instance was closed (or, on desktop, while the window was hidden to tray
    // and the event went to nobody) has no event left to catch — the read is what
    // makes the overlay correct rather than merely live.
    void applyPeerSettingsIfNewer()

    return () => {
      cancelled = true
      activeMirrorFlush = null
      if (timer) clearTimeout(timer)
      unsubChanges()
      unsub()
    }
  }, [client, storedKeyHex])
}
