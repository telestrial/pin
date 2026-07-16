import { useEffect } from 'react'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { publishChannelLocator } from '../channelLocator'

// Phase D step 4a (writer half) — publish each OWNED channel's pkarr locator (its
// own Sia object under K + the K-derived pkarr pointer) so cross-user readers can
// resolve it without atproto. Sibling to useChannelDocsMirror: a separate subscriber
// over feedStore.manifests ∩ myChannels, touching no atproto/doc write path. On a
// manifest change it (re)publishes the locator and deletes the SUPERSEDED Sia object
// (positive-id reclamation — no orphan sweep). Debounced, serialized, best-effort,
// lazy (pkarr wasm only loads once you actually own a channel).
//
// The per-channel "previous Sia object" pointer is persisted in localStorage so a
// republish across a reload still deletes the object it replaces (localStorage is a
// cache: losing it only risks a small stray manifest object, never data).

const DEBOUNCE_MS = 2000
const POINTER_PREFIX = 'pin:chanloc:'

type LocatorPointer = { id: string }

function readPointer(channelID: string): LocatorPointer | null {
  try {
    const s = localStorage.getItem(POINTER_PREFIX + channelID)
    return s ? (JSON.parse(s) as LocatorPointer) : null
  } catch {
    return null
  }
}
function writePointer(channelID: string, p: LocatorPointer): void {
  try {
    localStorage.setItem(POINTER_PREFIX + channelID, JSON.stringify(p))
  } catch {
    // localStorage unavailable/quota — the pointer is a cache, safe to skip.
  }
}
function clearPointer(channelID: string): void {
  try {
    localStorage.removeItem(POINTER_PREFIX + channelID)
  } catch {}
}
function pointerChannelIDs(): string[] {
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(POINTER_PREFIX)) out.push(k.slice(POINTER_PREFIX.length))
    }
  } catch {}
  return out
}

export function useChannelLocatorPublish() {
  const sdk = useAuthStore((s) => s.sdk)

  useEffect(() => {
    if (!sdk) return

    let cancelled = false
    let saving = false
    let pending = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // channelID -> last published manifest fingerprint (skip redundant publishes).
    const published = new Map<string, string>()

    const deleteObject = async (id: string) => {
      await sdk
        .deleteObject(id)
        .then(() => sdk.pruneSlabs())
        .catch(() => {})
    }

    const reconcile = async () => {
      saving = true
      try {
        const owned = new Map(
          useAuthStore
            .getState()
            .myChannels.map((c) => [c.channelID, c.channelKey]),
        )
        const { manifests } = useFeedStore.getState()

        // (Re)publish own channels whose manifest changed since last publish.
        for (const [channelID, keyB64] of owned) {
          if (cancelled) return
          const manifest = manifests[channelID]
          if (!manifest) continue
          const fingerprint = JSON.stringify(manifest)
          if (published.get(channelID) === fingerprint) continue

          const prev = readPointer(channelID)
          const { id } = await publishChannelLocator(sdk, keyB64, manifest)
          writePointer(channelID, { id })
          if (prev && prev.id !== id) await deleteObject(prev.id)
          published.set(channelID, fingerprint)
        }

        // Retract: a channel we published before that's no longer owned — delete its
        // Sia object + drop the pointer. The pkarr record isn't republished, so it
        // expires off the DHT by TTL.
        for (const channelID of pointerChannelIDs()) {
          if (cancelled) return
          if (owned.has(channelID)) continue
          const prev = readPointer(channelID)
          if (prev) await deleteObject(prev.id)
          clearPointer(channelID)
          published.delete(channelID)
        }
      } catch (e) {
        console.warn('channel locator publish failed:', e)
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
      if (s.myChannels !== p.myChannels) schedule()
    })
    // Catch channels already loaded before mount (don't boot pkarr for a user who
    // owns nothing).
    if (useAuthStore.getState().myChannels.length > 0) schedule()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unsubFeed()
      unsubAuth()
    }
  }, [sdk])
}
