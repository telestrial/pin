// This identity's request to read one private channel, kept current with the doc.
//
// The record is this identity's own, so a request made on another device of the same
// identity arrives here on the doc-change feed and the button says "Requested" there too.

import { useEffect, useState } from 'react'
import { join_request_collection } from '../../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../../core/wasm'
import { useAuthStore } from '../../stores/auth'
import { type JoinRequest, readMyRequest } from '../access'
import { openDocs, subscribeDocChanges } from '../docs'

/** The newest request about `channelID`, null when there is none, undefined until read. */
export function useMyRequest(
  channelID: string,
  enabled: boolean,
): JoinRequest | null | undefined {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const [read, setRead] = useState<{
    channelID: string
    request: JoinRequest | null
  } | null>(null)

  useEffect(() => {
    if (!enabled || !storedKeyHex) return
    let cancelled = false
    let unsub: (() => void) | undefined
    const load = () =>
      readMyRequest(channelID)
        .then((request) => {
          if (!cancelled) setRead({ channelID, request })
        })
        .catch(() => {})
    void (async () => {
      await openDocs(storedKeyHex)
      await ensureWasm()
      if (cancelled) return
      const collection = join_request_collection()
      unsub = subscribeDocChanges(({ collection: c, rkey }) => {
        if (c === collection && rkey === channelID) void load()
      })
      await load()
    })()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [storedKeyHex, channelID, enabled])

  return read?.channelID === channelID ? read.request : undefined
}
