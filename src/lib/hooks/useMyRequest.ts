// This identity's request to read one private channel, and whether it was turned down, kept
// current with the doc.
//
// Both records are this identity's own, so a request made, or a denial taken, on another
// device of the same identity arrives here on the doc-change feed.

import { useEffect, useState } from 'react'
import {
  join_denied_collection,
  join_request_collection,
} from '../../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../../core/wasm'
import { useAuthStore } from '../../stores/auth'
import { type JoinRequest, readDenied, readMyRequest } from '../access'
import { openDocs, subscribeDocChanges } from '../docs'

export type MyRequest = {
  /** The newest request about the channel, or null when there is none. */
  request: JoinRequest | null
  /** Whether the author turned down the request that is standing now. */
  denied: boolean
}

/** This identity's request about `channelID`, undefined until read. */
export function useMyRequest(
  channelID: string,
  enabled: boolean,
): MyRequest | undefined {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const [read, setRead] = useState<{
    channelID: string
    mine: MyRequest
  } | null>(null)

  useEffect(() => {
    if (!enabled || !storedKeyHex) return
    let cancelled = false
    let unsub: (() => void) | undefined
    const load = async () => {
      try {
        const [request, deniedAt] = await Promise.all([
          readMyRequest(channelID),
          readDenied(channelID),
        ])
        if (cancelled) return
        const denied =
          !!request && !request.withdrawn && deniedAt === request.createdAt
        setRead({ channelID, mine: { request, denied } })
      } catch {
        // A read that fails leaves the last answer standing.
      }
    }
    void (async () => {
      await openDocs(storedKeyHex)
      await ensureWasm()
      if (cancelled) return
      const watched = [join_request_collection(), join_denied_collection()]
      unsub = subscribeDocChanges(({ collection, rkey }) => {
        if (watched.includes(collection) && rkey === channelID) void load()
      })
      await load()
    })()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [storedKeyHex, channelID, enabled])

  return read?.channelID === channelID ? read.mine : undefined
}
