import { useCallback, useState } from 'react'
import { buildReachablePeople, type ReachablePerson } from '../../core/network'
import { useAuthStore } from '../../stores/auth'

// Session cache of the resolved reachable-people index, keyed by DID. Building
// it resolves an identity per reachable person, so we do it once per session and
// lazily — only when the composer actually needs candidates (first `@`).
const cache = new Map<string, ReachablePerson[]>()
const inFlight = new Map<string, Promise<ReachablePerson[]>>()

export function useMentionCandidates(): {
  candidates: ReachablePerson[]
  loading: boolean
  ensureLoaded: () => void
} {
  const myDID = useAuthStore((s) => s.atprotoDID)
  const [candidates, setCandidates] = useState<ReachablePerson[]>(() =>
    myDID ? (cache.get(myDID) ?? []) : [],
  )
  const [loading, setLoading] = useState(false)

  const ensureLoaded = useCallback(() => {
    if (!myDID) return
    const cached = cache.get(myDID)
    if (cached) {
      setCandidates(cached)
      return
    }
    if (inFlight.has(myDID)) return
    setLoading(true)
    // Read subscriptions at load time so this doesn't re-run on every sub tweak.
    const subs = useAuthStore.getState().subscriptions
    const r0 = [...new Set(subs.map((s) => s.authorDID).filter(Boolean))]
    const p = buildReachablePeople(myDID, r0)
    inFlight.set(myDID, p)
    p.then((people) => {
      cache.set(myDID, people)
      setCandidates(people)
    })
      .catch(() => {
        /* leave candidates empty; picker just shows no matches */
      })
      .finally(() => {
        inFlight.delete(myDID)
        setLoading(false)
      })
  }, [myDID])

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
