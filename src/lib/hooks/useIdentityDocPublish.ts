import { useEffect } from 'react'
import {
  DIRECTORY_DOC_VERSION,
  type DirectoryChannelRef,
  type DirectoryDoc,
} from '../../core/identityDoc'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { publishIdentityDoc } from '../identityDoc'

// Phase D step 3 (writer) — mirror this identity's PUBLIC directory (profile +
// advertised public channels + follows) into a pkarr/Sia identity document, so a
// visitor resolving the did:dht can read it without atproto. Sibling to
// useChannelDocsMirror / useChannelLocatorPublish: a separate subscriber touching no
// atproto write path (atproto stays source of truth this step; step 6 flips + drops
// the atproto profile/follow writes).
//
// Assembles from atproto/local each run (profile record, own public channels + their
// K, follow records). Fires on mount + owned-channel/manifest changes; a pure
// profile/follow edit (no store the hook watches) reflects on the next such trigger
// or next boot — a known lag, cosmetic while atproto is still the read source.
// Debounced, serialized, best-effort; superseded Sia object reclaimed via a
// localStorage pointer (positive-id, reload-safe).

const DEBOUNCE_MS = 2500
const POINTER_KEY = 'pin:iddoc:pointer'

function readPointerId(): string | null {
  try {
    const s = localStorage.getItem(POINTER_KEY)
    return s ? (JSON.parse(s) as { id: string }).id : null
  } catch {
    return null
  }
}
function writePointerId(id: string): void {
  try {
    localStorage.setItem(POINTER_KEY, JSON.stringify({ id }))
  } catch {}
}

export function useIdentityDocPublish() {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)

  useEffect(() => {
    if (!client || !storedKeyHex) return
    const appKeyBytes = Uint8Array.fromHex(storedKeyHex)

    let cancelled = false
    let saving = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // Fingerprint of the last published doc content (sans updatedAt) — skip
    // redundant publishes when nothing changed.
    let lastFingerprint: string | null = null

    const assemble = async (): Promise<DirectoryDoc | null> => {
      const { myChannels, follows, handleFollows, profile } =
        useAuthStore.getState()
      const { manifests } = useFeedStore.getState()

      // Own channels that are public → advertise them (with K so a resolver can
      // read them). Obscure channels stay unlisted.
      const channels: DirectoryChannelRef[] = myChannels.flatMap((c) => {
        const m = manifests[c.channelID]
        // Public + claimed (advertised). Unclaimed (advertised === false) and
        // obscure channels stay unlisted.
        if (!m || m.visibility !== 'public' || c.advertised === false) return []
        return [{ channelID: c.channelID, key: c.channelKey, name: m.name }]
      })

      // profile / follows / handleFollows are all iroh-native local state (the
      // settings doc) — no atproto read. Absent when just-reading / not yet set
      // → an emptier directory, still valid.
      // Nothing to advertise — don't publish an empty directory (or boot pkarr).
      if (
        !profile &&
        channels.length === 0 &&
        follows.length === 0 &&
        handleFollows.length === 0
      )
        return null

      return {
        version: DIRECTORY_DOC_VERSION,
        profile,
        channels,
        follows,
        handleFollows,
        updatedAt: new Date().toISOString(),
      }
    }

    const reconcile = async () => {
      saving = true
      try {
        const doc = await assemble()
        if (cancelled || !doc) return
        // Fingerprint everything but updatedAt (which changes every run).
        const fingerprint = JSON.stringify({ ...doc, updatedAt: '' })
        if (fingerprint === lastFingerprint) return

        const prevId = readPointerId()
        const { id } = await publishIdentityDoc(client, appKeyBytes, doc)
        writePointerId(id)
        if (prevId && prevId !== id) {
          await client
            .deleteObject(prevId)
            .then(() => client.pruneSlabs())
            .catch(() => {})
        }
        lastFingerprint = fingerprint
      } catch (e) {
        console.warn('identity doc publish failed:', e)
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

    const unsubFeed = useFeedStore.subscribe((s, p) => {
      if (s.manifests !== p.manifests) schedule()
    })
    const unsubAuth = useAuthStore.subscribe((s, p) => {
      if (
        s.myChannels !== p.myChannels ||
        s.follows !== p.follows ||
        s.handleFollows !== p.handleFollows ||
        s.profile !== p.profile
      )
        schedule()
    })
    // Publish on mount too (catches profile/follows set before mount + the common
    // case of a returning user whose channels loaded before this ran).
    schedule()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsubFeed()
      unsubAuth()
    }
  }, [client, storedKeyHex])
}
