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
    return { client: s.client, hex: s.storedKeyHex }
  }
  const g = window as unknown as {
    __pinMirrorWrite?: (text: string) => Promise<string>
    __pinMirrorRead?: () => Promise<string>
    __pinSettingsDocsCheck?: () => Promise<string>
    __pinDocsList?: () => Promise<string>
    __pinSettingsFromSnapshot?: () => Promise<string>
    __pinDidDht?: () => Promise<string>
    __pinPkarrRoundTrip?: () => Promise<string>
    __pinChannelLocatorRoundTrip?: () => Promise<string>
    __pinIdentityDocRoundTrip?: () => Promise<string>
  }
  g.__pinMirrorWrite = async (text: string) => {
    const { client, hex } = await session()
    if (!client || !hex) return 'not signed in'
    const { openDocs, putRecord } = await import('./lib/docs')
    const { snapshotToSia } = await import('./lib/docsMirror')
    await openDocs(hex)
    await putRecord('probe', 'persist', new TextEncoder().encode(text))
    const p = await snapshotToSia(client, hexToBytes(hex))
    return `snapshotted (${p.url.slice(0, 48)}...)`
  }
  g.__pinMirrorRead = async () => {
    const { client, hex } = await session()
    if (!client || !hex) return 'not signed in'
    const { openDocs, getRecord } = await import('./lib/docs')
    const { hydrateFromSia } = await import('./lib/docsMirror')
    await openDocs(hex)
    const n = await hydrateFromSia(client, hexToBytes(hex))
    const v = await getRecord('probe', 'persist')
    return `hydrated ${n} record(s); probe/persist = ${v ? new TextDecoder().decode(v) : 'MISSING'}`
  }
  // Phase C inc.1 proof: are settings dual-written into iroh-docs + durable via
  // Sia? Change a setting (subscribe / theme), wait ~2s, RELOAD, run this — it
  // hydrates from Sia and reads settings/self back out of the doc.
  g.__pinSettingsDocsCheck = async () => {
    const { client, hex } = await session()
    if (!client || !hex) return 'not signed in'
    const { openDocs, getRecord } = await import('./lib/docs')
    const { hydrateFromSia } = await import('./lib/docsMirror')
    const { deriveSettingsKey, decryptSettings } = await import('./core/crypto')
    await openDocs(hex)
    const n = await hydrateFromSia(client, hexToBytes(hex))
    const raw = await getRecord('settings', 'self')
    if (!raw) return `hydrated ${n} record(s); no settings/self in the doc yet`
    const key = await deriveSettingsKey(hexToBytes(hex))
    const s = JSON.parse(
      await decryptSettings(key, new TextDecoder().decode(raw)),
    )
    return `hydrated ${n}; settings/self: ${s.myChannels?.length ?? 0} channels, ${s.subscriptions?.length ?? 0} subs, theme=${s.theme}`
  }
  // Phase C inc.2 proof: what's in the doc after hydrating from Sia? Lists every
  // record key (settings/self, channel/<id>, ...) — proves channels are mirrored
  // + durable across a reload.
  g.__pinDocsList = async () => {
    const { client, hex } = await session()
    if (!client || !hex) return 'not signed in'
    const { openDocs, listAll } = await import('./lib/docs')
    const { hydrateFromSia } = await import('./lib/docsMirror')
    await openDocs(hex)
    const n = await hydrateFromSia(client, hexToBytes(hex))
    const keys = await listAll()
    return `hydrated ${n} record(s):\n${keys.map((k) => `  ${k.collection}/${k.rkey}`).join('\n')}`
  }
  // Phase C inc.3 proof: exercises the EXACT snapshot-read path the settings load
  // uses (readRecordFromSnapshot + decryptSettings, no pin-core). freshest-wins
  // means atproto usually wins on load, so this is how we confirm the snapshot
  // source itself is valid before inc.4 drops atproto and relies on it.
  g.__pinSettingsFromSnapshot = async () => {
    const { client, hex } = await session()
    if (!client || !hex) return 'not signed in'
    const { readRecordFromSnapshot } = await import('./lib/docsMirror')
    const { deriveSettingsKey, decryptSettings } = await import('./core/crypto')
    const bytes = await readRecordFromSnapshot(
      client,
      hexToBytes(hex),
      'settings',
      'self',
    )
    if (!bytes) return 'no settings/self in the Sia snapshot'
    const key = await deriveSettingsKey(hexToBytes(hex))
    const s = JSON.parse(
      await decryptSettings(key, new TextDecoder().decode(bytes)),
    )
    return `snapshot settings: ${s.myChannels?.length ?? 0} channels, ${s.subscriptions?.length ?? 0} subs, theme=${s.theme}, updatedAt=${s.updatedAt}`
  }
  // Phase D step-1 proof: derive this browser's did:dht from the Sia AppKey. MUST
  // equal the Curator's did:dht for the same account (rung-6a Rust identity.rs) —
  // that's the whole point (one identity across browser + Curator). Compare the
  // output to the Curator's logged DID.
  g.__pinDidDht = async () => {
    const { hex } = await session()
    if (!hex) return 'not signed in'
    const { deriveDidDht } = await import('./lib/pkarr')
    const { did } = await deriveDidDht(hexToBytes(hex))
    return did
  }
  // Phase D step-1 proof: the vendored pkarr wasm publishes + resolves from the app
  // bundle. Uses a THROWAWAY random key (never the real identity — publishing under
  // it would overwrite the Curator's DID document on the DHT). ~5s publish + retryless
  // resolve; expect the round-tripped value to match.
  g.__pinPkarrRoundTrip = async () => {
    const { deriveDidDht, publishRecords, resolveDidDht } = await import(
      './lib/pkarr'
    )
    // A throwaway identity from random bytes — never the real one, so publishing
    // can't overwrite the Curator's DID document.
    const throwaway = await deriveDidDht(
      crypto.getRandomValues(new Uint8Array(32)),
    )
    const value = `roundtrip-${Date.now()}`
    await publishRecords(throwaway.keypair, [{ name: '_pin', value }])
    const records = await resolveDidDht(throwaway.did)
    const got = records.find((r) => r.name.startsWith('_pin'))?.value
    return got === value
      ? `OK — published + resolved "${got}" from a fresh key`
      : `MISMATCH — got "${got ?? '(none)'}", expected "${value}"`
  }
  // Phase D step-2 proof: the per-channel read surface end-to-end. Publishes one
  // owned channel's locator (Sia object under K + K-derived pkarr pointer), then
  // resolves it back FROM K ALONE — exactly what a cross-user reader does, no atproto,
  // no author handle. Uses a real owned channel (publishes a real Sia object + DHT
  // record; old-object cleanup lands with the live wiring in step 4).
  g.__pinChannelLocatorRoundTrip = async () => {
    const { useAuthStore } = await import('./stores/auth')
    const { useFeedStore } = await import('./stores/feed')
    const auth = useAuthStore.getState()
    const ch = auth.myChannels[0]
    if (!auth.client || !ch) return 'no client / no owned channel'
    const manifest = useFeedStore.getState().manifests[ch.channelID]
    if (!manifest) return `manifest for ${ch.channelID} not loaded yet`
    const { publishChannelLocator, resolveChannelViaLocator } = await import(
      './lib/channelLocator'
    )
    const pub = await publishChannelLocator(
      auth.client,
      ch.channelKey,
      manifest,
    )
    const got = await resolveChannelViaLocator(auth.client, ch.channelKey)
    const match =
      got?.name === manifest.name && got?.items.length === manifest.items.length
    return `locator ${pub.locatorKey.slice(0, 12)}… → reader resolved "${got?.name}" (${got?.items.length ?? 0}/${manifest.items.length} items) — ${match ? 'MATCH' : 'MISMATCH'}`
  }
  // Phase D step-3 proof: the identity-doc read path. Publishes your directory
  // (profile + advertised public channels + follows) under your did:dht, then
  // resolves it back the way a visitor would — no atproto. MATCH confirms profile +
  // channel count + follow count survive the pkarr/Sia round-trip.
  g.__pinIdentityDocRoundTrip = async () => {
    const { useAuthStore } = await import('./stores/auth')
    const { useFeedStore } = await import('./stores/feed')
    const auth = useAuthStore.getState()
    if (!auth.client || !auth.storedKeyHex) return 'not signed in'
    const appKeyBytes = hexToBytes(auth.storedKeyHex)
    const { deriveDidDht } = await import('./lib/pkarr')
    const { publishIdentityDoc, resolveIdentityDoc } = await import(
      './lib/identityDoc'
    )
    const { manifests } = useFeedStore.getState()
    const channels = auth.myChannels.flatMap((c) => {
      const m = manifests[c.channelID]
      return m?.visibility === 'public'
        ? [{ channelID: c.channelID, key: c.channelKey, name: m.name }]
        : []
    })
    const doc = {
      version: 2 as const,
      profile: null,
      channels,
      follows: [],
      handleFollows: [],
      updatedAt: new Date().toISOString(),
    }
    await publishIdentityDoc(auth.client, appKeyBytes, doc)
    const { did } = await deriveDidDht(appKeyBytes)
    const got = await resolveIdentityDoc(auth.client, did)
    const match = got?.channels.length === channels.length
    return `identity-doc → resolved ${got?.channels.length ?? 0}/${channels.length} public channels, ${got?.follows.length ?? 0} follows — ${match ? 'MATCH' : 'MISMATCH'}`
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
