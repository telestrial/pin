import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Dev-only reload-persistence proof for the Sia-mirror durability layer
// (docsMirror). In the console: `await __pinMirrorWrite('hello')`, RELOAD, then
// `await __pinMirrorRead()` — it should come back from Sia. Removed once Phase C
// wires the mirror into real load/save paths.
if (import.meta.env.DEV) {
  const hexToBytes = (hex: string) => {
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return out
  }
  const session = async () => {
    const { useAuthStore } = await import('./stores/auth')
    const s = useAuthStore.getState()
    return { sdk: s.sdk, hex: s.storedKeyHex }
  }
  const g = window as unknown as {
    __pinMirrorWrite?: (text: string) => Promise<string>
    __pinMirrorRead?: () => Promise<string>
    __pinSettingsDocsCheck?: () => Promise<string>
  }
  g.__pinMirrorWrite = async (text: string) => {
    const { sdk, hex } = await session()
    if (!sdk || !hex) return 'not signed in'
    const { openDocs, putRecord } = await import('./lib/docs')
    const { snapshotToSia } = await import('./lib/docsMirror')
    await openDocs(hex)
    await putRecord('probe', 'persist', new TextEncoder().encode(text))
    const p = await snapshotToSia(sdk, hexToBytes(hex))
    return `snapshotted (${p.url.slice(0, 48)}...)`
  }
  g.__pinMirrorRead = async () => {
    const { sdk, hex } = await session()
    if (!sdk || !hex) return 'not signed in'
    const { openDocs, getRecord } = await import('./lib/docs')
    const { hydrateFromSia } = await import('./lib/docsMirror')
    await openDocs(hex)
    const n = await hydrateFromSia(sdk, hexToBytes(hex))
    const v = await getRecord('probe', 'persist')
    return `hydrated ${n} record(s); probe/persist = ${v ? new TextDecoder().decode(v) : 'MISSING'}`
  }
  // Phase C inc.1 proof: are settings dual-written into iroh-docs + durable via
  // Sia? Change a setting (subscribe / theme), wait ~2s, RELOAD, run this — it
  // hydrates from Sia and reads settings/self back out of the doc.
  g.__pinSettingsDocsCheck = async () => {
    const { sdk, hex } = await session()
    if (!sdk || !hex) return 'not signed in'
    const { openDocs, getRecord } = await import('./lib/docs')
    const { hydrateFromSia } = await import('./lib/docsMirror')
    const { deriveSettingsKey, decryptSettings } = await import('./core/crypto')
    await openDocs(hex)
    const n = await hydrateFromSia(sdk, hexToBytes(hex))
    const raw = await getRecord('settings', 'self')
    if (!raw) return `hydrated ${n} record(s); no settings/self in the doc yet`
    const key = await deriveSettingsKey(hexToBytes(hex))
    const s = JSON.parse(
      await decryptSettings(key, new TextDecoder().decode(raw)),
    )
    return `hydrated ${n}; settings/self: ${s.myChannels?.length ?? 0} channels, ${s.subscriptions?.length ?? 0} subs, theme=${s.theme}`
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
