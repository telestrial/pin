import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { inTauri } from './lib/openExternal'

// Dev diagnostics on `window`. Present in the web dev server (import.meta.env.DEV)
// AND in the desktop shell (inTauri()) — the latter matters because `dev:desktop`
// serves a PRODUCTION dist (DEV is false there), yet the Curator IPC hooks only run
// on desktop. Both are false in a plain web production build, so nothing here ships
// to a deployed web app. In the console: `await __pinMirrorWrite('hello')`, RELOAD,
// then `await __pinMirrorRead()` — it should come back from Sia.
if (import.meta.env.DEV || inTauri()) {
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
    __pinCuratorDocsRoundTrip?: () => Promise<string>
    __pinCuratorDocsList?: () => Promise<string>
    __pinSync?: {
      open: (hex: string) => Promise<string>
      openSession: () => Promise<string>
      share: () => Promise<string>
      sync: (ticket: string) => Promise<void>
      rendezvousPublish: (hex: string) => Promise<string>
      rendezvousConnect: (hex: string) => Promise<string>
      put: (collection: string, rkey: string, value: string) => Promise<void>
      get: (collection: string, rkey: string) => Promise<string | null>
      events: () => string[]
    }
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
  // "One repo" Slice A proof (DESKTOP ONLY): drive the native Curator's persistent
  // iroh-docs replica through put / get / list / delete over Tauri IPC. Proves the
  // frontend can reach the SAME replica the Curator serves over iroh — the mechanic
  // Slice B routes docs.ts through. Enable curation first (the doc lives in the
  // running Curator), then run this in the desktop shell's console.
  g.__pinCuratorDocsRoundTrip = async () => {
    const { inTauri } = await import('./lib/openExternal')
    if (!inTauri()) return 'desktop only (run in the Pin desktop app)'
    const { curatorDocsSelfTest } = await import('./lib/tauriDocs')
    return curatorDocsSelfTest()
  }
  // List the native Curator's records (DESKTOP ONLY) — read-only, no mutation.
  // The verification for slice 1b: after a browser tab writes over sync, run this
  // in the desktop shell to confirm the record landed in the Curator's repo.
  g.__pinCuratorDocsList = async () => {
    const { inTauri } = await import('./lib/openExternal')
    if (!inTauri()) return 'desktop only (run in the Pin desktop app)'
    const { listAllNative } = await import('./lib/tauriDocs')
    const all = await listAllNative()
    return all.length === 0
      ? '(no records)'
      : all.map((k) => `${k.collection}/${k.rkey}`).join('\n')
  }
  // Sync-loopback harness (slice 1a): drive docs.ts's OWN sync verbs across two
  // browser tabs to prove two replicas of one identity converge bidirectionally
  // over the relay — a browser tab as the ticket PRODUCER (serving node), no
  // desktop, no Sia. open() derives the namespace from the AppKey hex via HKDF and
  // binds an iroh endpoint; it never touches Sia, so the hex can be any 32 bytes and
  // no sign-in is needed. Driven by e2e/sync/sync-loopback.spec.ts. The verbs are
  // lazy (docs.ts, and its 7 MB wasm, only load when a hook is first called).
  {
    const syncEvents: string[] = []
    // A per-page-load instance id for the rendezvous directory (the app uses its own
    // in useRendezvousSync; this is the harness's).
    const RZ_INSTANCE = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const docs = () => import('./lib/docs')
    g.__pinSync = {
      open: async (hex) => (await docs()).openDocs(hex),
      // Open the doc under the signed-in account's AppKey — the desktop Curator's
      // SAME namespace (both derive it from the one recovery phrase). The 1b
      // browser-tab convenience: no need to fish the hex out of the store by hand.
      // NOTE: openDocs is now memoized (docs.ts) — same key returns the app's live
      // engine, so this shares whatever the app already opened this session rather
      // than rebuilding a throwaway one.
      openSession: async () => {
        const { useAuthStore } = await import('./stores/auth')
        const hex = useAuthStore.getState().storedKeyHex
        if (!hex) throw new Error('not signed in')
        return (await docs()).openDocs(hex)
      },
      share: async () => (await docs()).shareDoc(),
      sync: async (ticket) =>
        (await docs()).startSync(ticket, (l) => {
          syncEvents.push(l)
        }),
      // Rendezvous auto-discovery: one instance advertises its coords in the
      // additive directory (per this page's instance id); another discovers + resolves
      // + startSyncs, no manual copy. Each page (context) gets its own RZ_INSTANCE.
      rendezvousPublish: async (hex) => {
        await (await import('./lib/rendezvous')).advertiseInstance(
          hex,
          RZ_INSTANCE,
          false,
        )
        return 'advertised'
      },
      rendezvousConnect: async (hex) =>
        (await import('./lib/rendezvous')).autoConnectRendezvous(
          hex,
          RZ_INSTANCE,
          (l) => {
            syncEvents.push(l)
          },
        ),
      put: async (collection, rkey, value) =>
        (await docs()).putRecord(
          collection,
          rkey,
          new TextEncoder().encode(value),
        ),
      get: async (collection, rkey) => {
        try {
          const b = await (await docs()).getRecord(collection, rkey)
          return b ? new TextDecoder().decode(b) : null
        } catch {
          // Content lags RBSR metadata in iroh-blobs — a key can sync before its
          // blob lands, so get_bytes throws briefly. Treat as "not ready" and let
          // the caller poll.
          return null
        }
      },
      events: () => syncEvents.slice(),
    }
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

// Dev-only cross-device sync harness at `#synctest` — a standalone tap-driven UI
// (no console, no USB) for proving iroh-docs live-sync between two devices. Gated
// DEV || inTauri and lazy-imported, so it never enters a prod bundle. Everything
// else boots the normal app.
if (
  (import.meta.env.DEV || inTauri()) &&
  window.location.hash.toLowerCase().includes('synctest')
) {
  import('./components/dev/SyncTestPanel').then(({ SyncTestPanel }) =>
    createRoot(root).render(
      <StrictMode>
        <SyncTestPanel />
      </StrictMode>,
    ),
  )
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
