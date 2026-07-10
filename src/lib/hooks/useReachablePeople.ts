import { useEffect, useState } from 'react'
import { countReachablePeople, type NetworkReach } from '../../core/network'
import { useAuthStore } from '../../stores/auth'

// Session cache keyed by DID. The walk is a handful of network calls (one
// listFollows per person you hold), so we hold the result across view mounts
// and don't recompute on every subscription tweak — a stale count for the
// session is fine for a raw readout.
const cache = new Map<string, NetworkReach>()

export function useReachablePeople(): {
  reach: NetworkReach | null
  loading: boolean
  error: string | null
} {
  const myDID = useAuthStore((s) => s.atprotoDID)
  const [reach, setReach] = useState<NetworkReach | null>(() =>
    myDID ? (cache.get(myDID) ?? null) : null,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!myDID) return
    const cached = cache.get(myDID)
    if (cached) {
      setReach(cached)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    // Read subscriptions at walk time via getState (not a selector) so the
    // effect keys on myDID alone and doesn't re-walk on every sub mutation.
    const subs = useAuthStore.getState().subscriptions
    const r0 = [...new Set(subs.map((s) => s.authorDID).filter(Boolean))]
    countReachablePeople(myDID, r0)
      .then((res) => {
        if (cancelled) return
        cache.set(myDID, res)
        setReach(res)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [myDID])

  return { reach, loading, error }
}
