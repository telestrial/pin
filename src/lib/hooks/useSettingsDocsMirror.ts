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
import { useStorageActivityStore } from '../../stores/storageActivity'
import {
  getRecord,
  isRemoteChange,
  openDocs,
  putRecord,
  subscribeDocChanges,
} from '../docs'

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

/** How long a change waits for the next one, so a burst becomes one doc write.
 *
 *  COALESCING, and nothing more. It was 2000ms for a job it no longer has: back when
 *  the boot catch-up could mirror an empty store, the delay was the only thing standing
 *  between that write and the restore racing it — and a debounce is not an ordering
 *  primitive, which is exactly why 2s against a multi-second network read was a coin
 *  toss that Chrome usually won and Firefox always lost. `settingsLoaded` is the
 *  ordering primitive now, and it is absolute rather than timed, so this no longer has
 *  to cover anything.
 *
 *  What is left wants a window long enough to catch one mutation touching several
 *  fields and short enough to be invisible. Every extra second only widens the gap
 *  where a closed tab leaves the change unmirrored — recoverable, since the boot
 *  catch-up pushes it on the `settingsLoaded` transition, but work for nothing. */
export const SETTINGS_MIRROR_DEBOUNCE_MS = 250
// Exported so the tests name it once rather than spelling it a second time.
export const FINGERPRINT_KEY = 'pin:docsnapshot:settingsFingerprint'
// The `updatedAt` carried by the record this device last mirrored.
//
// Kept beside the fingerprint rather than in the auth store because it is the same kind
// of fact — something about the last mirror, not part of the account — and because a new
// field in the store's `partialize` reads as `undefined` for everyone on upgrade, which
// for a neighbour like `settingsObjectID` would strand a snapshot generation.
//
// It exists so the boot load can tell an OLDER record from a NEWER one. The read side
// below distinguishes them by fingerprint, which answers "does this differ from what I
// mirrored" and not "which of the two is newer" — enough for a live peer write, and not
// enough at boot, where the doc is refilled from a snapshot that can predate local state.
// Exported so the tests name it once rather than spelling it a second time.
export const MIRRORED_AT_KEY = 'pin:docsnapshot:settingsMirroredAt'

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

/** Whether the doc's copy is behind the store, so a mirror is owed.
 *
 *  A device that has never mirrored owes one, which is why an absent fingerprint counts
 *  as behind. Spelled out at four call sites before this, which is three chances for one
 *  of them to drift into a different answer to the same question. */
function needsMirroring(): boolean {
  return settingsFingerprint() !== readFingerprint()
}

/** Whether the store has moved since this device last mirrored.
 *
 *  Close to `needsMirroring` and deliberately not the same, because they disagree on the
 *  case that matters: a device that has never mirrored owes a write, and it is NOT ahead
 *  of the doc — it has nothing to be ahead with. Answering that one "yes" would have the
 *  read side refuse to load, so a new account could never start.
 *
 *  This is what replaces `settingsDirty`. The flag was set by one of the store's dozen
 *  mutations, so creating a channel left it reading "mirrored" while the channel had
 *  reached nothing. A fingerprint cannot fall out of step that way: whatever the
 *  mutation was, the state either matches what was mirrored or it does not. */
export function localIsAheadOfMirror(): boolean {
  return readFingerprint() !== null && needsMirroring()
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

/** The `updatedAt` of the state this device last mirrored, or null if it never has. */
export function lastMirroredAt(): string | null {
  try {
    return localStorage.getItem(MIRRORED_AT_KEY)
  } catch {
    return null
  }
}

function writeMirroredAt(iso: string): void {
  try {
    localStorage.setItem(MIRRORED_AT_KEY, iso)
  } catch {
    // Same posture as the fingerprint: without it the boot load cannot compare and
    // falls back to applying what the doc holds, which is where it stood before this.
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
      // NOTHING IS MIRRORED BEFORE THE LOAD HAS ESTABLISHED WHAT LOCAL STATE IS.
      //
      // A fresh tab holds an empty persisted store and no fingerprint, so those differ
      // and the boot catch-up below schedules a mirror of that emptiness. The restore it
      // is racing is a DHT resolve and a Sia download, which outlasts any debounce worth
      // having — so the write lands first, carries a newer `updatedAt` than
      // the peer's, and the peer's overlay applies it. That is the cross-device wipe, and
      // it is a WRITE-side failure: the reader being careful cannot help when the writer
      // publishes state it never read.
      //
      // `settingsLoaded` is only true once the doc has answered — hydrated, positively
      // empty, or local being the fresher copy — so it is exactly the question this needs
      // answered before it may publish. The transition back into `schedule` is below, or
      // a boot with unmirrored local state would never push it.
      if (!useAuthStore.getState().settingsLoaded) return
      const fp = settingsFingerprint()
      // Already mirrored this exact content — skip before touching pin-core.
      if (fp === readFingerprint()) return
      saving = true
      useStorageActivityStore.getState().setSavingSettings(true)
      try {
        await ensureOpen()
        if (cancelled) return
        const state = useAuthStore.getState()
        // Minted once, here, and remembered below. This is the ONLY place a settings
        // `updatedAt` is stamped, which is what lets the boot load compare without every
        // mutation having to remember that it changed something.
        const updatedAt = new Date().toISOString()
        const settings: DispatchSettings = {
          version: SETTINGS_VERSION,
          myChannels: state.myChannels,
          subscriptions: state.subscriptions,
          dismissedAutoWatch: state.dismissedAutoWatch,
          theme: state.theme,
          follows: state.follows,
          handleFollows: state.handleFollows,
          profile: state.profile,
          updatedAt,
        }
        const key = await deriveSettingsKey(appKeyBytes)
        const enc = await encryptSettings(key, JSON.stringify(settings))
        await putRecord('settings', 'self', new TextEncoder().encode(enc))
        // Only advance the fingerprint on full success — a failure leaves it
        // stale so the next change/boot retries (no silent loss). Same for the
        // timestamp: claiming to have mirrored state that did not land would let a
        // later boot refuse a doc record that really was newer.
        writeFingerprint(fp)
        writeMirroredAt(updatedAt)
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
      }, SETTINGS_MIRROR_DEBOUNCE_MS)
    }

    const unsub = useAuthStore.subscribe((s, p) => {
      // The load finishing is itself a reason to mirror: `mirror` declines while settings
      // are unloaded, so whatever the boot catch-up wanted to push was dropped rather
      // than deferred. Without this a session whose local state was never mirrored — a
      // crash mid-write last time — would keep it local forever.
      if (!p.settingsLoaded && s.settingsLoaded) {
        schedule()
        return
      }
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
    if (needsMirroring()) schedule()

    // Flush contract (durable-when-done): await any in-flight mirror, then mirror
    // once if still stale. Callers awaiting this get the current settings durable
    // on Sia — the replacement for the dropped atproto flush.
    activeMirrorFlush = async () => {
      while (saving) await new Promise((r) => setTimeout(r, 50))
      if (needsMirroring()) await mirror()
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
        if (needsMirroring()) return

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
          !needsMirroring(),
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
    let unsubChanges: (() => void) | null = null
    void (async () => {
      // After the doc is open: on desktop the feed is served by the Curator's engine,
      // and attaching before it exists fails silently for the whole session — which
      // would leave this overlay reading only on mount, so a peer's settings change
      // would land on the next launch and never while running.
      await openDocs(storedKeyHex)
      if (cancelled) return
      unsubChanges = subscribeDocChanges(({ collection, kind }) => {
        if (!isRemoteChange(kind)) return
        if (collection && collection !== 'settings') return
        void applyPeerSettingsIfNewer()
      })
      // Push for speed, pull for truth: read once on mount. A change that landed while
      // this instance was closed (or, on desktop, while the window was hidden to tray
      // and the event went to nobody) has no event left to catch — the read is what
      // makes the overlay correct rather than merely live. After the subscribe, so a
      // change arriving between the two isn't lost.
      void applyPeerSettingsIfNewer()
    })()

    return () => {
      cancelled = true
      activeMirrorFlush = null
      if (timer) clearTimeout(timer)
      unsubChanges?.()
      unsub()
    }
  }, [client, storedKeyHex])
}
