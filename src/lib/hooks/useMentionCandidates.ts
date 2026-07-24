import { useCallback, useState } from 'react'
import { buildReachablePeople, type ReachablePerson } from '../../core/network'
import { useAuthStore } from '../../stores/auth'
import { deriveDidDht } from '../pkarr'
import { makeReach } from '../reach'

// Session cache of the resolved reachable-people index, keyed by my did:dht.
// Building it resolves an identity-doc per reachable person, so we do it once
// per session and lazily — only when the composer actually needs candidates
// (first `@`).
const cache = new Map<string, ReachablePerson[]>()
const inFlight = new Map<string, Promise<ReachablePerson[]>>()

export function useMentionCandidates(): {
  candidates: ReachablePerson[]
  loading: boolean
  ensureLoaded: () => void
} {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const [candidates, setCandidates] = useState<ReachablePerson[]>([])
  const [loading, setLoading] = useState(false)

  const ensureLoaded = useCallback(() => {
    if (!client || !storedKeyHex) return
    setLoading(true)
    void (async () => {
      const { did: me } = await deriveDidDht(Uint8Array.fromHex(storedKeyHex))
      const cached = cache.get(me)
      if (cached) {
        setCandidates(cached)
        setLoading(false)
        return
      }
      if (inFlight.has(me)) {
        setLoading(false)
        return
      }
      // Read subscriptions at load time so this doesn't re-run on every sub
      // tweak; seed with the did:dht-native subs.
      const subs = useAuthStore.getState().subscriptions
      const r0 = [
        ...new Set(subs.map((s) => s.didDht).filter((d): d is string => !!d)),
      ]
      const { fetch, resolve } = makeReach(client)
      const p = buildReachablePeople(me, r0, { fetch, resolve })
      inFlight.set(me, p)
      p.then((people) => {
        cache.set(me, people)
        setCandidates(people)
      })
        .catch(() => {
          /* leave candidates empty; picker just shows no matches */
        })
        .finally(() => {
          inFlight.delete(me)
          setLoading(false)
        })
    })()
  }, [client, storedKeyHex])

  return { candidates, loading, ensureLoaded }
}

// Filter the candidate pool by the text typed after `@`. Empty query shows the
// nearest people (the list is already sorted nearest-first). Matches username or
// handle, case-insensitive substring. Capped so the panel stays small.
export function filterMentionCandidates(
  candidates: readonly ReachablePerson[],
  query: string,
  limit = 8,
): ReachablePerson[] {
  const q = query.trim().toLowerCase()
  const matches = q
    ? candidates.filter(
        (c) =>
          c.username?.toLowerCase().includes(q) ||
          c.handle.toLowerCase().includes(q),
      )
    : candidates
  return matches.slice(0, limit)
}
