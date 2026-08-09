import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { usePinStore } from '../../stores/pin'
import { isRemoteChange, subscribeDocChanges } from '../docs'
import { snapshotToSia } from '../docsMirror'
import {
  collection as pinnedCollection,
  pinRkey,
  readPinRecords,
  syncPinRecords,
} from '../pinRecords'

// Your library, kept in the doc and kept in step with it.
//
// Both directions, because a pin is a decision rather than a cache: it has to survive
// this device and show up on your others. The Zustand store stays as the local runtime
// — it's what the UI renders, and its localStorage copy is what makes boot instant —
// but the doc record is the durable one.
//
// WRITE side. Reconciles on a debounce, because a channel pin fans out one store
// change per item and an N-item channel would otherwise reconcile N times against the
// network. Crucially it reconciles ADDITIVELY, and names the pins it released rather
// than inferring them: two devices share this doc, so "absent from my list" cannot
// mean "delete it" — that would erase whatever the other device just pinned. The
// transition from one local list to the next is what identifies a release.
//
// READ side. Applies the doc's records back into the store, guarded the same way the
// settings overlay is: only when our own local state is fully recorded. A local edge
// we haven't pushed yet must not be overwritten by a doc that hasn't heard about it —
// the mirror will push it, and then this resumes. When local IS recorded, the doc is
// authoritative and its content wins, deletions included, which is how another
// device's unpin reaches this one.

const DEBOUNCE_MS = 1500

export function usePinDocsMirror() {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!client || !storedKeyHex) return

    let cancelled = false
    let saving = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // Pins released locally since the last successful reconcile, by rkey. Held until
    // the reconcile clears them so a failed pass retries the release rather than
    // forgetting it — a forgotten release is a record that outlives its pin.
    const released = new Set<string>()
    // The rkeys currently recorded in the doc by us. `local === recorded` is the
    // clean-state test the read side gates on.
    let recorded: string | null = null
    // The pin collection's name, from Rust. Resolved once; until it lands the change
    // filter lets everything through, which costs a guarded no-op re-read at worst.
    let collName: string | null = null
    void pinnedCollection().then((c) => {
      collName = c
    })

    // Set while the store is being updated FROM the doc, so the write side can tell
    // "the user did this" from "we just applied what the doc said".
    let applying = false

    const localFingerprint = async () => {
      const keys = await Promise.all(
        usePinStore.getState().pinned.map((p) => pinRkey(p)),
      )
      return keys.sort().join('\n')
    }

    const reconcile = async () => {
      saving = true
      const releasing = [...released]
      try {
        const pinned = usePinStore.getState().pinned
        const result = await syncPinRecords(storedKeyHex, pinned, releasing)
        if (cancelled) return
        for (const r of releasing) released.delete(r)
        recorded = await localFingerprint()
        // Only snapshot when the doc actually moved. The snapshot is a Sia upload;
        // paying for one when nothing changed would make every quiet pass expensive.
        if (result.written > 0 || result.deleted > 0) {
          await snapshotToSia(client, storedKeyHex)
        }
      } catch (e) {
        // The next change retries. A pin that failed to record is still held locally,
        // so nothing is lost yet — but it hasn't travelled, so say so.
        console.warn('pin docs-mirror failed (will retry):', e)
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
        else void reconcile()
      }, DEBOUNCE_MS)
    }

    const unsub = usePinStore.subscribe((s, p) => {
      if (s.pinned === p.pinned) return
      // A change WE made by adopting the doc isn't a local decision, and reading it
      // as one would turn another device's unpin into a release of our own — a
      // delete of a record that's already gone, and a Sia snapshot to pay for it.
      if (applying) return
      // Positively identify what was released: present a moment ago, gone now. This
      // is the knowledge the reconcile cannot get from the doc, and the reason it
      // never deletes on its own.
      void (async () => {
        const now = new Set(await Promise.all(s.pinned.map((x) => pinRkey(x))))
        for (const old of p.pinned) {
          const rkey = await pinRkey(old)
          if (!now.has(rkey)) released.add(rkey)
        }
        schedule()
      })()
    })

    const applyRecords = async () => {
      if (applying) return
      applying = true
      try {
        // Don't overwrite work we haven't recorded yet. `recorded` is null until the
        // first successful reconcile, which is exactly the state where we can't tell
        // an unpushed local pin from one this doc has never held.
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

    // Driven by the doc's change feed, like the settings overlay: the engine says when
    // a pin record moved. `isRemoteChange` filters our own writes, which would bounce
    // straight back; an empty collection is a stream-level event (content finishing its
    // download) and counts.
    const unsubChanges = subscribeDocChanges(({ collection, kind }) => {
      if (!isRemoteChange(kind)) return
      if (collection && collName && collection !== collName) return
      void applyRecords()
    })

    // Boot: record what this device holds, then read back whatever else the doc has.
    // Push for speed, pull for truth — a pin made elsewhere while this instance was
    // closed has no event left to catch.
    schedule()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsubChanges()
      unsub()
    }
  }, [client, storedKeyHex])
}
