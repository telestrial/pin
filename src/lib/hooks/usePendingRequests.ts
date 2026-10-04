// The requests waiting on this identity, per private channel it owns, kept current with the
// doc.
//
// One read for every channel, behind both the Requests panel and the count beside each
// channel in the sidebar, so the number and the list cannot disagree. The rule for who is
// waiting is `pendingRequests`; this only gathers what it is handed.

import { useEffect, useMemo, useState } from 'react'
import {
  join_decision_collection,
  join_inbox_collection,
  members_collection,
} from '../../../crates/pin-core/pkg/pin_core.js'
import {
  type InboxRequest,
  pendingRequests,
  type RequestDecision,
} from '../../core/requests'
import { ensureWasm } from '../../core/wasm'
import { useAuthStore } from '../../stores/auth'
import { getRecord, listRecords, openDocs, subscribeDocChanges } from '../docs'
import { readRoster, standingMembers } from '../members'

type Held = {
  inbox: InboxRequest[]
  /** By `channelID:did`, which is how decisions are keyed. */
  decisions: Map<string, RequestDecision>
  /** Standing members' dids, by channel. */
  members: Map<string, Set<string>>
}

async function readAll<T>(collection: string): Promise<[string, T][]> {
  const out: [string, T][] = []
  for (const rkey of await listRecords(collection)) {
    const bytes = await getRecord(collection, rkey)
    if (!bytes) continue
    try {
      out.push([rkey, JSON.parse(new TextDecoder().decode(bytes)) as T])
    } catch {
      // A record that will not parse is one fewer row, nothing more.
    }
  }
  return out
}

/** Pending requests per owned private channel, null until read. */
export function usePendingRequests(): Map<string, InboxRequest[]> | null {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const myChannels = useAuthStore((s) => s.myChannels)
  const handleFollows = useAuthStore((s) => s.handleFollows)
  const follows = useAuthStore((s) => s.follows)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const [held, setHeld] = useState<Held | null>(null)

  const privateIDs = useMemo(
    () =>
      myChannels
        .filter((c) => c.visibility === 'private')
        .map((c) => c.channelID),
    [myChannels],
  )
  const privateKey = privateIDs.join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: privateKey names privateIDs' content, which is what the read depends on
  useEffect(() => {
    if (!storedKeyHex || privateIDs.length === 0) {
      setHeld(null)
      return
    }
    let cancelled = false
    let unsub: (() => void) | undefined
    const load = async () => {
      try {
        const inbox = (
          await readAll<InboxRequest>(join_inbox_collection())
        ).map(([, r]) => r)
        const decisions = new Map(
          await readAll<RequestDecision>(join_decision_collection()),
        )
        const members = new Map<string, Set<string>>()
        for (const id of privateIDs) {
          members.set(
            id,
            new Set(standingMembers(await readRoster(id)).map((s) => s.did)),
          )
        }
        if (!cancelled) setHeld({ inbox, decisions, members })
      } catch {
        // A read that fails leaves the last answer standing.
      }
    }
    void (async () => {
      await openDocs(storedKeyHex)
      await ensureWasm()
      if (cancelled) return
      const watched = [
        join_inbox_collection(),
        join_decision_collection(),
        members_collection(),
      ]
      unsub = subscribeDocChanges(({ collection }) => {
        if (watched.includes(collection)) void load()
      })
      await load()
    })()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [storedKeyHex, privateKey])

  return useMemo(() => {
    if (!held) return null
    const graph = new Set<string>([
      ...handleFollows,
      ...follows.map((f) => f.didDht),
      ...subscriptions.flatMap((s) => (s.didDht ? [s.didDht] : [])),
    ])
    const out = new Map<string, InboxRequest[]>()
    for (const id of privateIDs) {
      const decisions = new Map<string, RequestDecision>()
      for (const [rkey, d] of held.decisions) {
        if (rkey.startsWith(`${id}:`))
          decisions.set(rkey.slice(id.length + 1), d)
      }
      out.set(
        id,
        pendingRequests(
          id,
          held.inbox,
          decisions,
          held.members.get(id) ?? new Set(),
          graph,
        ),
      )
    }
    return out
  }, [held, privateIDs, handleFollows, follows, subscriptions])
}
