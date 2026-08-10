import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { useCuratorStore } from '../../stores/curator'
import { usePinStore } from '../../stores/pin'
import { subscribeDocChanges } from '../docs'
import { cacheSnapshotPointer } from '../docsMirror'
import {
  collection as publishedCollection,
  readPublished,
  settingsPublishKey,
} from '../publishState'

// Where the Curator's snapshot got to, projected back out of the doc.
//
// The snapshot itself is the Curator's — one writer, reading the doc (see
// `crates/pin-curator/src/snapshot.rs`). What the frontend still needs from it is two
// small things, and both come from the same record it writes.
//
// THE BOOT CACHE. On web the doc lives in memory, so at boot there is no doc to read a
// pointer out of — the pointer is what tells you which Sia object to download to GET a
// doc. The Curator has no localStorage to break that circularity with, so this does:
// while the app runs, whatever the Curator publishes is cached locally, and the next
// boot starts from it.
//
// THE MIRROR STATUS on the Curate page, which used to be reported by whichever hook
// happened to take the snapshot. Reading it from the record instead means desktop and
// web report the same thing from the same place, rather than each platform having its
// own path to the same fact.
//
// And the storage meter, for the same reason it was told before: a snapshot is an
// upload and a prune, so the account's storage moved. The meter reads once at connect
// and then only when something tells it, so without this it would sit at whatever it
// last saw.

export function useSnapshotPointer() {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!storedKeyHex) return
    let cancelled = false
    // The publish-state collection's name, from Rust. Until it resolves the filter
    // lets everything through, which costs a guarded no-op read at worst.
    let collName: string | null = null
    void publishedCollection().then((c) => {
      collName = c
    })

    const refresh = async () => {
      try {
        const rkey = await settingsPublishKey()
        const published = await readPublished(storedKeyHex, rkey)
        if (cancelled || !published?.url) return
        cacheSnapshotPointer({ id: published.id ?? '', url: published.url })
        useCuratorStore.getState().set({
          mirrorState: 'pushed',
          mirrorUrl: published.url,
          mirrorError: null,
        })
        const client = useAuthStore.getState().client
        if (client) usePinStore.getState().refreshAccount(client)
      } catch {
        // The engine may not be open yet, or the record not downloaded — the next
        // change announces itself and this runs again.
      }
    }

    // Any publish-state write is a candidate: the snapshot's is the one we want, and
    // reading the wrong one costs a guarded no-op.
    const unsub = subscribeDocChanges(({ collection }) => {
      if (collection && collName && collection !== collName) return
      void refresh()
    })
    void refresh()

    return () => {
      cancelled = true
      unsub()
    }
  }, [storedKeyHex])
}
