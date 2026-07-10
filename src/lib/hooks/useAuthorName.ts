import { useEffect, useState } from 'react'
import { getProfileRecord } from '../../core/profile'

// Session cache: atproto handle (or DID) → the author's self-chosen Pin @handle,
// or null meaning "resolved, but they have no Pin handle." null is a real cached
// value (distinct from undefined = not-yet-resolved) so we don't refetch authors
// who simply haven't set one. In-memory only; a rename just means a stale label
// until the next session, which is fine — the name was never load-bearing.
const cache = new Map<string, string | null>()
const inFlight = new Map<string, Promise<string | null>>()

function resolve(id: string): Promise<string | null> {
  const cached = cache.get(id)
  if (cached !== undefined) return Promise.resolve(cached)
  const existing = inFlight.get(id)
  if (existing) return existing
  const p = getProfileRecord(id)
    .then((profile) => {
      const username = profile?.username ?? null
      cache.set(id, username)
      return username
    })
    .catch(() => {
      // Network/other failure caches null: this is the fallback-to-handle
      // path anyway, and caching avoids hammering a flaky lookup per render.
      cache.set(id, null)
      return null
    })
    .finally(() => {
      inFlight.delete(id)
    })
  inFlight.set(id, p)
  return p
}

// Returns the name to *display* for an author: their self-chosen Pin @handle if
// they have one, else the atproto handle passed in. Navigation everywhere still
// keys on the atproto handle — this only changes the label, never the router
// (the Pin handle is non-unique, so it isn't a resolvable address). Fetches lazily
// and caches per session, so feeds render instantly with the handle and upgrade to
// the username as profiles resolve.
export function useAuthorName(atprotoHandle: string): string {
  const [username, setUsername] = useState<string | null>(
    () => cache.get(atprotoHandle) ?? null,
  )

  useEffect(() => {
    if (!atprotoHandle) return
    const cached = cache.get(atprotoHandle)
    if (cached !== undefined) {
      // Already resolved this session — apply synchronously, no fetch, no flash.
      setUsername(cached)
      return
    }
    let cancelled = false
    resolve(atprotoHandle).then((u) => {
      if (!cancelled) setUsername(u)
    })
    return () => {
      cancelled = true
    }
  }, [atprotoHandle])

  return username || atprotoHandle
}
