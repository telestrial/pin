// In-memory fake of core/jetstream.ts's connectJetstream function.
// Same signature, same returned conn shape, same semantics — but the
// transport is FakeRecordStore subscription instead of a WebSocket.
//
// Integration tests inject this via vi.mock('../core/jetstream', ...) so
// the production app's useJetstream hook ends up driving from the fake
// record store. When alice's FakeAgent writes a record, bob's app sees
// a JetStream commit fire — same shape, no actual network involved.

import { ALL_CHANNEL_LEXICONS } from '../core/atproto'
import type { FakeRecordStore, RecordEvent } from './fakeAgent'

export type CommitEvent = {
  did: string
  rkey: string
  operation: 'create' | 'update' | 'delete'
}

export type JetstreamListeners = {
  onCommit: (event: CommitEvent) => void
  onConnected?: () => void
  onDisconnected?: () => void
}

export type JetstreamConn = {
  close(): void
  update(dids: string[]): void
}

const COLLECTIONS = new Set<string>(ALL_CHANNEL_LEXICONS)

export function connectFakeJetstream(
  store: FakeRecordStore,
  initialDids: string[],
  listeners: JetstreamListeners,
): JetstreamConn {
  let dids = new Set(initialDids)
  let closed = false
  let unsubscribe: (() => void) | null = null

  function attach() {
    if (closed || dids.size === 0 || unsubscribe) return
    listeners.onConnected?.()
    unsubscribe = store.subscribe((e: RecordEvent) => {
      if (!dids.has(e.did)) return
      if (!COLLECTIONS.has(e.collection)) return
      listeners.onCommit({
        did: e.did,
        rkey: e.rkey,
        operation: e.operation,
      })
    })
  }

  function detach() {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
      listeners.onDisconnected?.()
    }
  }

  function close() {
    if (closed) return
    closed = true
    detach()
  }

  function update(newDids: string[]) {
    if (closed) return
    dids = new Set(newDids)
    if (dids.size === 0) {
      detach()
    } else {
      // Attach if we weren't already; the filter set is read live on each
      // event, so re-attaching isn't needed when the DID set changes mid-flight.
      attach()
    }
  }

  attach()

  return { close, update }
}
