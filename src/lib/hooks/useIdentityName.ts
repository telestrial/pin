import { useEffect, useState } from 'react'
import { useAuthStore } from '../../stores/auth'
import { resolveIdentityDoc } from '../identityDoc'

// What a did:dht's identity-doc says about them, as anything rendering a person needs it.
// A subset of the profile record rather than the record itself, so a caller can't come to
// depend on a field this cache doesn't promise to keep.
export type IdentityProfile = {
  username: string | null
  displayName: string | null
  avatarURL: string | null
}

// Session cache: did:dht → their profile, or null = "resolved, and they published none."
// The did:dht counterpart to useAuthorName, sourced from the identity-doc on pkarr/Sia (no
// atproto). null is a real cached value (vs undefined = not-yet-resolved) so we don't
// refetch authors without one.
//
// The WHOLE profile is cached rather than only the username, because the fetch is the same
// one either way: resolving an identity-doc is a DHT resolve plus a Sia download, and
// keeping one field of what came back would make the avatar cost a second round trip for
// bytes already in hand.
const cache = new Map<string, IdentityProfile | null>()
const inFlight = new Map<string, Promise<IdentityProfile | null>>()

function resolve(
  client: unknown,
  didDht: string,
): Promise<IdentityProfile | null> {
  const cached = cache.get(didDht)
  if (cached !== undefined) return Promise.resolve(cached)
  const existing = inFlight.get(didDht)
  if (existing) return existing
  const p = resolveIdentityDoc(
    // biome-ignore lint/suspicious/noExplicitAny: client typed loosely to keep the hook off the SDK import
    client as any,
    didDht,
  )
    .then((doc) => {
      const profile = doc?.profile
        ? {
            username: doc.profile.username ?? null,
            displayName: doc.profile.displayName ?? null,
            avatarURL: doc.profile.avatarURL ?? null,
          }
        : null
      cache.set(didDht, profile)
      return profile
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

/** Everything a row needs to render a person, or null until it resolves.
 *
 *  Your own identity never resolves over the network: the profile in settings is the truth,
 *  and the published doc lags local edits and may not have propagated at all. */
export function useIdentityProfile(didDht: string): IdentityProfile | null {
  const client = useAuthStore((s) => s.client)
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const mine = useAuthStore((s) => s.profile)
  const isSelf = !!didDht && didDht === myDidDht
  const [profile, setProfile] = useState<IdentityProfile | null>(
    () => cache.get(didDht) ?? null,
  )

  useEffect(() => {
    if (!didDht || !client || isSelf) return
    const cached = cache.get(didDht)
    if (cached !== undefined) {
      setProfile(cached)
      return
    }
    let cancelled = false
    resolve(client, didDht).then((p) => {
      if (!cancelled) setProfile(p)
    })
    return () => {
      cancelled = true
    }
  }, [didDht, client, isSelf])

  if (isSelf) {
    return {
      username: mine?.username ?? null,
      displayName: mine?.displayName ?? null,
      avatarURL: mine?.avatarURL ?? null,
    }
  }
  return profile
}

// Display name for a did:dht author: their identity-doc username if set, else a
// short truncation of the did:dht (never a bare, unreadable key). Lazy + cached,
// so feeds render instantly and upgrade as identity-docs resolve.
export function useIdentityName(didDht: string): string {
  const client = useAuthStore((s) => s.client)
  // Your own identity resolves locally: profile is the source of truth (and the
  // published doc may lag local edits / not have propagated yet on the DHT), so
  // never network-resolve yourself.
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const myUsername = useAuthStore((s) => s.profile?.username)
  const isSelf = !!didDht && didDht === myDidDht
  const [username, setUsername] = useState<string | null>(
    () => cache.get(didDht)?.username ?? null,
  )

  useEffect(() => {
    if (!didDht || !client || isSelf) return
    const cached = cache.get(didDht)
    if (cached !== undefined) {
      setUsername(cached?.username ?? null)
      return
    }
    let cancelled = false
    resolve(client, didDht).then((p) => {
      if (!cancelled) setUsername(p?.username ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [didDht, client, isSelf])

  // Fallback: `did:dht:iyyp…db4o` (last chars are the most distinguishing).
  const key = didDht.replace(/^did:dht:/, '')
  const fallback = `did:dht:…${key.slice(-6)}`
  if (isSelf) return myUsername || fallback
  return username || fallback
}
