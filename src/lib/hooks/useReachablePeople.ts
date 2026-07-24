import { useEffect, useState } from 'react'
import { countReachablePeople, type NetworkReach } from '../../core/network'
import { useAuthStore } from '../../stores/auth'
import { deriveDidDht } from '../pkarr'
import { makeReach } from '../reach'

// Session cache keyed by my did:dht. The walk is a handful of identity-doc
// resolves (one per person you hold), so we hold the result across view mounts
// and don't recompute on every subscription tweak — a stale count for the
// session is fine for a raw readout.
const cache = new Map<string, NetworkReach>()

export function useReachablePeople(): {
  reach: NetworkReach | null
  loading: boolean
  error: string | null
} {
  const client = useAuthStore((s) => s.client)
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const [reach, setReach] = useState<NetworkReach | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client || !storedKeyHex) return
    let cancelled = false
    void (async () => {
      const { did: me } = await deriveDidDht(Uint8Array.fromHex(storedKeyHex))
      if (cancelled) return
      const cached = cache.get(me)
      if (cached) {
        setReach(cached)
        return
      }
      setLoading(true)
      setError(null)
      // Read subscriptions at walk time so this doesn't re-walk on every sub
      // mutation; seed with the did:dht-native subs (legacy handle subs, which
      // carry no did:dht, aren't part of the iroh reach graph).
      const subs = useAuthStore.getState().subscriptions
      const r0 = [
        ...new Set(subs.map((s) => s.didDht).filter((d): d is string => !!d)),
      ]
      try {
        const res = await countReachablePeople(me, r0, {
          fetch: makeReach(client).fetch,
        })
        if (cancelled) return
        cache.set(me, res)
        setReach(res)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, storedKeyHex])

  return { reach, loading, error }
}
