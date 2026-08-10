import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { usePinStore } from '../../stores/pin'
import { isRemoteChange, subscribeDocChanges } from '../docs'
import {
  drainPendingReleases,
  collection as pinnedCollection,
  pinRkey,
  readPinRecords,
  syncPinRecords,
} from '../pinRecords'

// Your library, kept in step with the doc.
//
// The WRITING is done where the deciding is: `pinStore.pin` records a pin as it makes
// it, and `unpin` releases the record as it drops it. That is the whole reason this
// file is small — an action knows exactly what it did, where something watching a list
// change afterwards has to work it out, and can't ever be sure whether an absence is a
// release or a pin another device made that hasn't reached it yet.
//
// What's left is the two things an action can't do for itself.
//
// CATCH-UP. A doc write that failed leaves a pin held locally but not travelling, and a
// device that pinned while offline has a whole list in that state. So on boot, and
// whenever the doc says something moved, anything missing is written. Additive only:
// this never deletes, because from here an absence is unreadable. Failed releases are
// retried separately, from the record the unpin left behind.
//
// READ. Applies the doc's records back into the store, gated on our own state being
// fully recorded — a local pin we haven't pushed must not be overwritten by a doc that
// hasn't heard about it. When local IS recorded the doc wins, deletions included, which
// is how another device's unpin reaches this one.

export function usePinDocsMirror() {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!storedKeyHex) return
    let cancelled = false
    let busy = false
    // The rkeys we've confirmed are recorded. `local === recorded` is the clean-state
    // test the read side gates on; null until the first catch-up, which is exactly the
    // state where an unpushed pin and one the doc never held look the same.
    let recorded: string | null = null
    // The pin collection's name, from Rust. Until it resolves the change filter lets
    // everything through, which costs a guarded no-op at worst.
    let collName: string | null = null
    void pinnedCollection().then((c) => {
      collName = c
    })
    // Set while the store is being updated FROM the doc, so a change we caused doesn't
    // read as one to catch up on.
    let applying = false

    const localFingerprint = async () => {
      const keys = await Promise.all(
        usePinStore.getState().pinned.map((p) => pinRkey(p)),
      )
      return keys.sort().join('\n')
    }

    const catchUp = async () => {
      if (busy) return
      busy = true
      try {
        await drainPendingReleases(storedKeyHex)
        await syncPinRecords(storedKeyHex, usePinStore.getState().pinned)
        if (cancelled) return
        recorded = await localFingerprint()
      } catch (e) {
        // Leaves `recorded` as it was, so the read side stays out of the way until
        // this device's own pins have travelled.
        console.warn('pin catch-up failed (will retry):', e)
      } finally {
        busy = false
      }
    }

    const applyRecords = async () => {
      if (applying) return
      applying = true
      try {
        if (recorded === null || (await localFingerprint()) !== recorded) return
        const fromDoc = await readPinRecords(storedKeyHex)
        if (cancelled) return
        const next = [...fromDoc].sort((a, b) =>
          a.pinnedAt.localeCompare(b.pinnedAt),
        )
        const keys = next.map((p) => `${p.objectID}:${p.item.itemURL}`).join()
        const current = usePinStore
          .getState()
          .pinned.map((p) => `${p.objectID}:${p.item.itemURL}`)
          .join()
        if (keys === current) return
        usePinStore.getState().adoptPinned(next)
        recorded = await localFingerprint()
      } catch {
        // Transient (engine mid-open, a record mid-download) — the next change
        // announces itself and this runs again.
      } finally {
        applying = false
      }
    }

    // Driven by the doc's change feed. `isRemoteChange` filters our own writes, which
    // would bounce straight back; an empty collection is a stream-level event (content
    // finishing its download) and counts.
    const unsubChanges = subscribeDocChanges(({ collection, kind }) => {
      if (!isRemoteChange(kind)) return
      if (collection && collName && collection !== collName) return
      void applyRecords()
    })

    // A local change means there may be something to catch up on — a record whose write
    // failed, most often. Cheap when there isn't: syncPinRecords skips records that
    // already say what they should.
    const unsubStore = usePinStore.subscribe((s, p) => {
      if (s.pinned === p.pinned || applying) return
      void catchUp()
    })

    // Boot: get this device's pins recorded, then read back whatever else the doc has.
    // Push for speed, pull for truth — a pin made elsewhere while this instance was
    // closed has no event left to catch.
    void catchUp().then(() => {
      if (!cancelled) void applyRecords()
    })

    return () => {
      cancelled = true
      unsubChanges()
      unsubStore()
    }
  }, [storedKeyHex])
}
