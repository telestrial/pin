import { useEffect, useState } from 'react'
import { useAuthStore } from '../../stores/auth'
import { readDirectory } from '../directories'
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

/** The three fields a row renders, from whichever source produced them. */
function displayable(profile: {
  username?: string
  displayName?: string
  avatarURL?: string
}): IdentityProfile {
  return {
    username: profile.username ?? null,
    displayName: profile.displayName ?? null,
    avatarURL: profile.avatarURL ?? null,
  }
}

// What the Curator's crawl already recorded about them, or undefined when it has never
// read them. A held record with no profile answers `null` — that is a real answer, not a
// miss, so it stops here rather than spending a lookup to be told the same thing.
async function fromIndex(
  appKeyHex: string,
  didDht: string,
): Promise<IdentityProfile | null | undefined> {
  const held = await readDirectory(appKeyHex, didDht)
  if (!held) return undefined
  return held.profile ? displayable(held.profile) : null
}

// The people half of the resolution ladder, and the reason a reload no longer costs a DHT
// lookup and a Sia download per person in the feed. `PostRow` asks for three of these per
// row, so a fifty-row feed used to spend fifty round trips to resolve names it had
// resolved a moment earlier.
//
// Preference-ordered: the session map, then what the crawl holds, then the network. The
// crawl's copy can lag a rename by a crawl cadence, which is the ladder's ordinary trade —
// it wrote what it read from the same place this fallback reads.
function resolve(
  client: unknown,
  appKeyHex: string | null,
  didDht: string,
): Promise<IdentityProfile | null> {
  const cached = cache.get(didDht)
  if (cached !== undefined) return Promise.resolve(cached)
  const existing = inFlight.get(didDht)
  if (existing) return existing
  const p = (async () => {
    if (appKeyHex) {
      const held = await fromIndex(appKeyHex, didDht).catch(() => undefined)
      if (held !== undefined) return held
    }
    const doc = await resolveIdentityDoc(
      // biome-ignore lint/suspicious/noExplicitAny: client typed loosely to keep the hook off the SDK import
      client as any,
      didDht,
    )
    return doc?.profile ? displayable(doc.profile) : null
  })()
    .catch(() => null)
    .then((profile) => {
      cache.set(didDht, profile)
      return profile
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
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
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
    resolve(client, storedKeyHex, didDht).then((p) => {
      if (!cancelled) setProfile(p)
    })
    return () => {
      cancelled = true
    }
  }, [didDht, client, storedKeyHex, isSelf])

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
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
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
    resolve(client, storedKeyHex, didDht).then((p) => {
      if (!cancelled) setUsername(p?.username ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [didDht, client, storedKeyHex, isSelf])

  // Fallback: `did:dht:iyyp…db4o` (last chars are the most distinguishing).
  const key = didDht.replace(/^did:dht:/, '')
  const fallback = `did:dht:…${key.slice(-6)}`
  if (isSelf) return myUsername || fallback
  return username || fallback
}
