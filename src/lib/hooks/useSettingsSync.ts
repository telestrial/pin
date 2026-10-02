import { useEffect } from 'react'
import { decryptSettings, deriveSettingsKey } from '../../core/crypto'
import { type DispatchSettings, SETTINGS_VERSION } from '../../core/settings'
import { useAuthStore } from '../../stores/auth'
import { useCuratorStore } from '../../stores/curator'
import { getRecord, openDocs } from '../docs'
import {
  flushSettingsMirror,
  lastMirroredAt,
  localIsAheadOfMirror,
} from './useSettingsDocsMirror'

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

// Load this identity's settings from the doc, once the restore has settled.
//
// THE DOC IS THE ONLY SOURCE, which is the boundary this file used to sit outside of:
// the Curator owns state and the network, and the frontend reads the repo. This hook
// resolved settings by reaching past that — its own Sia download, its own locator
// recovery, its own decision about what an unreadable snapshot meant — and that second
// recovery path is what emptied an account. It read the snapshot, a failure came back
// indistinguishable from an absence, the naming gate fired on the empty state it left,
// and the `settings/self` that naming wrote carried a newer timestamp than the peer's.
//
// So the two paths are one now. The doc holds `settings/self`; what fills the doc differs
// by platform for a physical reason and is already handled in `useDocRestore` — a redb
// store already has it, a MemStore is refilled from the snapshot. Either way this reads
// one record and the distinction never reaches here.
//
// `docRestore` is what makes an absence mean something. Ready is the restore having put
// back what the snapshot held, or having established there was nothing to put back;
// unknown is nobody having answered, and this hook then does NOT load, so the naming gate
// stays away and no loop publishes. A browser where Sia cannot be read now declines to
// start rather than publishing an empty identity over a full one. That is the 08-07
// lockout objection answered rather than dodged: the read retries with backoff and the
// account survives being unreadable, where it did not survive being read as empty.
/** Whether `candidate` is strictly older than `held`.
 *
 *  The safe direction for an unreadable timestamp is chosen here rather than inside a
 *  parse, because the two callers of that choice want opposite things. Here an
 *  unparseable candidate counts as older and is refused: being wrong costs a session
 *  that keeps local state and re-mirrors it, where being wrong the other way overwrites
 *  an account with a record nobody could date. A held stamp that will not parse is the
 *  one this device wrote, so it is treated as no stamp at all and the candidate wins.
 */
function isOlder(candidate: string | undefined, held: string): boolean {
  const h = Date.parse(held)
  if (Number.isNaN(h)) return false
  const c = candidate ? Date.parse(candidate) : Number.NaN
  if (Number.isNaN(c)) return true
  return c < h
}

export function useSettingsSync() {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const docRestored = useCuratorStore((s) => s.docRestore === 'ready')

  useEffect(() => {
    if (!client || !storedKeyHex || !docRestored) return
    if (useAuthStore.getState().settingsLoaded) return

    let cancelled = false
    ;(async () => {
      try {
        // Local holds mutations that were never mirrored (a crash mid-write last
        // session). Local is fresher, so mark loaded and let the mirror's boot catch-up
        // push it out; reading the doc over it would clobber the newer state.
        //
        // Asked of the state rather than of a flag. The flag this replaces was set by
        // one of the store's dozen mutations, so creating a channel left it saying
        // "mirrored" while the channel had reached nothing, and the read below went
        // ahead over the top of it. A fingerprint cannot fall out of step that way:
        // whatever the mutation was, the state either matches what was mirrored or it
        // does not. Same predicate the peer overlay already guards with.
        if (localIsAheadOfMirror()) {
          useAuthStore.getState().setSettingsLoaded(true)
          return
        }

        await openDocs(storedKeyHex)
        if (cancelled) return
        const raw = await getRecord('settings', 'self')
        if (cancelled) return
        if (!raw) {
          // No record, and the restore is what makes that an answer rather than a gap:
          // a brand-new identity, which is the state every account starts in.
          useAuthStore.getState().setSettingsLoaded(true)
          return
        }

        const key = await deriveSettingsKey(Uint8Array.fromHex(storedKeyHex))
        const s = JSON.parse(
          await decryptSettings(key, new TextDecoder().decode(raw)),
        ) as DispatchSettings
        if (cancelled) return
        if (s.version !== SETTINGS_VERSION) {
          // Never apply what cannot be trusted. Loaded anyway: the version is a fact
          // about the record rather than a failure to read it, and refusing to load
          // would leave the app unable to start with no way out.
          useAuthStore.getState().setSettingsLoaded(true)
          return
        }
        // Refuse a record older than the state this device already holds.
        //
        // `settingsDirty` above is the same question asked through a proxy, and the
        // proxy does not reach: exactly one mutation in the store sets that flag, so
        // creating a channel leaves it false and a stale record read over the top of a
        // channel that exists. On web that is ordinary rather than exotic — the doc is
        // a MemStore that dies with the tab, the durable copy is the Sia snapshot, and
        // it lands seconds after the local write, so a refresh in between restores a
        // doc that predates whatever was just made.
        //
        // Comparing timestamps asks the real question, and it asks it of every record
        // rather than of the mutations somebody remembered to mark. Refusing still
        // marks the load done: the app has to start, and the mirror's catch-up pushes
        // local state out, which makes the doc current again.
        const mirroredAt = lastMirroredAt()
        if (mirroredAt && isOlder(s.updatedAt, mirroredAt)) {
          useAuthStore.getState().setSettingsLoaded(true)
          return
        }
        useAuthStore
          .getState()
          .hydrateSettings(
            s.myChannels,
            s.subscriptions,
            s.theme ?? useAuthStore.getState().theme,
            s.follows ?? [],
            s.handleFollows ?? [],
            s.profile ?? null,
            s.dismissedInvitations ?? [],
          )
      } catch (e) {
        if (cancelled) return
        // A doc read that threw, which is NOT an absence of settings. Staying unloaded
        // holds the naming gate and every publishing loop; the effect re-runs when the
        // restore reports again. Converting this into a load is the bug this hook had.
        console.warn('Settings load failed; staying unloaded:', e)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client, storedKeyHex, docRestored])
}
