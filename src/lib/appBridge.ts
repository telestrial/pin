// Host-side bridge for sandboxed app items. Apps run in null-origin
// iframes with no localStorage of their own — this lets them persist state
// via postMessage RPC. Storage is scoped by appID (the Sia content hash
// of the HTML), so the same bytes share state across the channels that
// publish them.

const STORAGE_PREFIX = 'app-state'

type GetRequest = {
  type: 'dispatch:state.get'
  requestID: string
  key: string
}

type SetRequest = {
  type: 'dispatch:state.set'
  requestID: string
  key: string
  value: unknown
}

type Request = GetRequest | SetRequest

function isRequest(data: unknown): data is Request {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (d.type !== 'dispatch:state.get' && d.type !== 'dispatch:state.set') {
    return false
  }
  return typeof d.requestID === 'string' && typeof d.key === 'string'
}

export function installAppBridge(
  getIframe: () => HTMLIFrameElement | null,
  appID: string,
): () => void {
  const handler = (e: MessageEvent) => {
    const iframe = getIframe()
    if (!iframe) return
    if (e.source !== iframe.contentWindow) return
    if (!isRequest(e.data)) return

    const req = e.data
    const storageKey = `${STORAGE_PREFIX}:${appID}:${req.key}`
    const post = (msg: unknown) =>
      iframe.contentWindow?.postMessage(msg, '*')

    if (req.type === 'dispatch:state.get') {
      const stored = localStorage.getItem(storageKey)
      let value: unknown = null
      if (stored !== null) {
        try {
          value = JSON.parse(stored)
        } catch {
          value = null
        }
      }
      post({
        type: 'dispatch:state.get.result',
        requestID: req.requestID,
        value,
      })
      return
    }

    try {
      localStorage.setItem(storageKey, JSON.stringify(req.value))
      post({
        type: 'dispatch:state.set.result',
        requestID: req.requestID,
        ok: true,
      })
    } catch (err) {
      post({
        type: 'dispatch:state.set.result',
        requestID: req.requestID,
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to set',
      })
    }
  }

  window.addEventListener('message', handler)
  return () => window.removeEventListener('message', handler)
}
