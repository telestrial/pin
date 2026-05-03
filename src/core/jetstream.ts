import { ALL_CHANNEL_LEXICONS } from './atproto'

const JETSTREAM_US_EAST = 'wss://jetstream2.us-east.bsky.network/subscribe'
const JETSTREAM_US_WEST = 'wss://jetstream2.us-west.bsky.network/subscribe'
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000

function pickJetstreamEndpoint(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const westCoastTZs = new Set([
    'America/Los_Angeles',
    'America/Anchorage',
    'America/Vancouver',
    'America/Tijuana',
    'America/Whitehorse',
  ])
  if (
    tz.startsWith('Pacific/') ||
    tz.startsWith('Asia/') ||
    tz.startsWith('Australia/') ||
    westCoastTZs.has(tz)
  ) {
    return JETSTREAM_US_WEST
  }
  return JETSTREAM_US_EAST
}

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

export function connectJetstream(
  initialDids: string[],
  listeners: JetstreamListeners,
): JetstreamConn {
  let dids = [...initialDids]
  let ws: WebSocket | null = null
  let closed = false
  let reconnectAttempts = 0
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null

  const endpoint = pickJetstreamEndpoint()

  function buildURL(): string {
    const params = new URLSearchParams()
    for (const lexicon of ALL_CHANNEL_LEXICONS) {
      params.append('wantedCollections', lexicon)
    }
    for (const did of dids) {
      params.append('wantedDids', did)
    }
    return `${endpoint}?${params.toString()}`
  }

  function connect() {
    if (closed) return
    if (dids.length === 0) return

    const conn = new WebSocket(buildURL())
    ws = conn

    conn.onopen = () => {
      reconnectAttempts = 0
      listeners.onConnected?.()
    }

    conn.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string)
        if (msg.kind !== 'commit') return
        if (
          !ALL_CHANNEL_LEXICONS.includes(
            msg.commit?.collection as (typeof ALL_CHANNEL_LEXICONS)[number],
          )
        )
          return
        listeners.onCommit({
          did: msg.did,
          rkey: msg.commit.rkey,
          operation: msg.commit.operation,
        })
      } catch (err) {
        console.warn('jetstream parse error:', err)
      }
    }

    conn.onerror = (e) => {
      console.warn('jetstream error:', e)
    }

    conn.onclose = () => {
      listeners.onDisconnected?.()
      if (ws === conn) ws = null
      if (closed) return
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** reconnectAttempts,
        RECONNECT_MAX_MS,
      )
      reconnectAttempts++
      reconnectTimeout = setTimeout(connect, delay)
    }
  }

  function close() {
    closed = true
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    if (ws) {
      const old = ws
      old.onclose = null
      old.close()
      ws = null
    }
  }

  function update(newDids: string[]) {
    const sortedOld = [...dids].sort().join(',')
    const sortedNew = [...newDids].sort().join(',')
    if (sortedOld === sortedNew) return
    dids = [...newDids]
    // Tear down the existing socket without triggering the backoff reconnect,
    // then immediately reconnect with the new filter.
    if (ws) {
      const old = ws
      old.onclose = null
      old.close()
      ws = null
    }
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    reconnectAttempts = 0
    connect()
  }

  connect()

  return { close, update }
}
