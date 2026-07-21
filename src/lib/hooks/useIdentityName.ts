import { useEffect, useState } from 'react'
import { useAuthStore } from '../../stores/auth'
import { resolveIdentityDoc } from '../identityDoc'

// Session cache: did:dht → the author's self-chosen Pin @handle (profile.username),
// or null = "resolved, no username." The did:dht counterpart to useAuthorName, but
// sourced from the identity-doc on pkarr/Sia (no atproto). null is a real cached
// value (vs undefined = not-yet-resolved) so we don't refetch authors without one.
const cache = new Map<string, string | null>()
const inFlight = new Map<string, Promise<string | null>>()

function resolve(sdk: unknown, didDht: string): Promise<string | null> {
  const cached = cache.get(didDht)
  if (cached !== undefined) return Promise.resolve(cached)
  const existing = inFlight.get(didDht)
  if (existing) return existing
  const p = resolveIdentityDoc(
    // biome-ignore lint/suspicious/noExplicitAny: sdk typed loosely to keep the hook off the SDK import
    sdk as any,
    didDht,
  )
    .then((doc) => {
      const username = doc?.profile?.username ?? null
      cache.set(didDht, username)
      return username
    })
    .catch(() => {
      cache.set(didDht, null)
      return null
    })
    .finally(() => {
      inFlight.delete(didDht)
    })
  inFlight.set(didDht, p)
  return p
}

// Display name for a did:dht author: their identity-doc username if set, else a
// short truncation of the did:dht (never a bare, unreadable key). Lazy + cached,
// so feeds render instantly and upgrade as identity-docs resolve.
export function useIdentityName(didDht: string): string {
  const sdk = useAuthStore((s) => s.sdk)
  // Your own identity resolves locally: profile is the source of truth (and the
  // published doc may lag local edits / not have propagated yet on the DHT), so
  // never network-resolve yourself.
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const myUsername = useAuthStore((s) => s.profile?.username)
  const isSelf = !!didDht && didDht === myDidDht
  const [username, setUsername] = useState<string | null>(
    () => cache.get(didDht) ?? null,
  )

  useEffect(() => {
    if (!didDht || !sdk || isSelf) return
    const cached = cache.get(didDht)
    if (cached !== undefined) {
      setUsername(cached)
      return
    }
    let cancelled = false
    resolve(sdk, didDht).then((u) => {
      if (!cancelled) setUsername(u)
    })
    return () => {
      cancelled = true
    }
  }, [didDht, sdk, isSelf])

  // Fallback: `did:dht:iyyp…db4o` (last chars are the most distinguishing).
  const key = didDht.replace(/^did:dht:/, '')
  const fallback = `did:dht:…${key.slice(-6)}`
  if (isSelf) return myUsername || fallback
  return username || fallback
}
