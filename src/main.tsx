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
    __pinRestoreDiag?: () => Promise<string>
    __pinSettingsFromSnapshot?: () => Promise<string>
    __pinDidDht?: () => Promise<string>
    __pinPkarrRoundTrip?: () => Promise<string>
    __pinChannelLocatorRoundTrip?: () => Promise<string>
    __pinCuratorDocsRoundTrip?: () => Promise<string>
    __pinCuratorDocsList?: () => Promise<string>
    __pinSubDiag?: () => Promise<string>
    __pinDeliverProbe?: () => Promise<string>
    __pinDirDiag?: () => Promise<string>
    __pinDiscoverDiag?: (howMany?: number) => Promise<string>
    __pinChannelDocs?: {
      author: (hexOverride?: string) => Promise<string>
      subscriber: (ticket: string, hexOverride?: string) => Promise<string>
    }
    __pinChannelDocLive?: {
      publish: (name: string, hexOverride?: string) => Promise<string>
      subscribe: (
        channelID: string,
        channelKey: string,
        hexOverride?: string,
        cachedHead?: string,
      ) => Promise<string>
    }
    __pinSync?: {
      open: (hex: string) => Promise<string>
      openSession: () => Promise<string>
      share: () => Promise<string>
      sync: (ticket: string) => Promise<void>
      put: (collection: string, rkey: string, value: string) => Promise<void>
      get: (collection: string, rkey: string) => Promise<string | null>
      events: () => string[]
      watchChanges: () => Promise<string>
      changes: () => Array<{ collection: string; rkey: string; kind: string }>
      startPull: (hex: string) => Promise<string>
      passes: () => string[]
      startKeepAlive: (hex: string) => Promise<string>
      keepAlivePasses: () => string[]
      startInstance: (hex: string) => Promise<string>
      instancePasses: () => string[]
      startIdentity: (hex: string) => Promise<string>
      identityPasses: () => string[]
      startEngagement: (hex: string) => Promise<string>
      engagementPasses: () => string[]
      startDeliver: (hex: string) => Promise<string>
      deliverPasses: () => string[]
      startChannelDocs: (hex: string) => Promise<string>
      channelDocPasses: () => string[]
      startChannelSync: (hex: string) => Promise<string>
      channelSyncPasses: () => string[]
      startRendezvous: (hex: string) => Promise<string>
      rendezvousPasses: () => string[]
    }
  }
  // Channel docs (the ladder's top rung), driven through whichever engine is active:
  // the wasm engine on web, the native Curator over IPC on desktop. `author` writes a
  // channel record and prints a read ticket; run `subscriber(ticket)` on a SECOND
  // instance (another tab, or desktop↔tab) to prove import + live-sync + read-only.
  // `hexOverride` lets the sync-tier spec drive these with a fixed key and no
  // sign-in — openDocs is pure HKDF + an iroh bind, never touching Sia.
  g.__pinChannelDocs = {
    author: async (hexOverride?: string) => {
      const hex = hexOverride ?? (await session()).hex
      if (!hex) return 'not signed in'
      const { channelDocsSelfTest } = await import('./lib/docs')
      return channelDocsSelfTest(hex)
    },
    subscriber: async (ticket: string, hexOverride?: string) => {
      const hex = hexOverride ?? (await session()).hex
      if (!hex) return 'not signed in'
      const { channelDocsImportTest } = await import('./lib/docs')
      return channelDocsImportTest(hex, ticket)
    },
  }
  // Ladder rung 1 end to end: an author serves a channel through the Curator's real
  // channel-doc loop, and a subscriber resolves the ticket from the content key a cached
  // head gives it (no ticket handed over out of band) and live-syncs the manifest into
  // its feed. `channelKey` is fresh
  // per run so the pkarr read is a first read, not an overwrite — public relays lag on
  // overwrites (see CLAUDE.md 2026-07-23).
  //
  // The author side seeds the doc the way a real publish would — a sealed manifest under
  // `channel/<id>`, and a settings record naming the channel as owned — and then starts
  // the loop and waits for it to advertise. That's deliberate: serving a channel is the
  // Curator's job, so a harness that served one itself would be a second implementation
  // of the thing under test, and it would keep passing after the real one broke.
  g.__pinChannelDocLive = {
    publish: async (name: string, hexOverride?: string) => {
      const hex = hexOverride ?? (await session()).hex
      if (!hex) return 'not signed in'
      const {
        generateChannelKey,
        channelKeyToBase64,
        deriveChannelID,
        encryptSettings,
        deriveSettingsKey,
        deriveChannelDocSeed,
      } = await import('./core/crypto')
      const { CHANNEL_MANIFEST_VERSION } = await import('./core/types')
      const { SETTINGS_VERSION } = await import('./core/settings')
      type Manifest = import('./core/types').ChannelManifest
      const { openDocs, openChannelDoc, putRecord, startChannelDocLoop } =
        await import('./lib/docs')
      const { ensureWasm } = await import('./core/wasm')
      await ensureWasm()
      const { channel_seal } = await import(
        '../crates/pin-core/pkg/pin_core.js'
      )

      const k = await generateChannelKey()
      const channelKey = channelKeyToBase64(k)
      const channelID = await deriveChannelID(k)
      const manifest: Manifest = {
        version: CHANNEL_MANIFEST_VERSION,
        name,
        description: 'rung-1 probe',
        authorPubkey: 'probe',
        publishedAt: new Date().toISOString(),
        items: [],
      }

      await openDocs(hex)
      const appKey = Uint8Array.fromHex(hex)
      const enc = new TextEncoder()

      // What a commit leaves behind: the manifest sealed as its author seals it, under the
      // channel's id.
      await putRecord(
        'channel',
        channelID,
        enc.encode(channel_seal(hex, k, JSON.stringify(manifest))),
      )
      // And an older copy of the same channel, for the subscriber to hold as the pull loop
      // would leave it after a read from Sia. A subscriber finds the live doc under the
      // content key, which only a head it has opened can tell it — and the copy is older,
      // so the manifest it then has to be PUSHED is the one that proves the live rung.
      const cachedHead = channel_seal(
        hex,
        k,
        JSON.stringify({
          ...manifest,
          name: `${name} (before the push)`,
          publishedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      )
      // And what tells the loop this channel is ours to serve.
      const settings = {
        version: SETTINGS_VERSION,
        myChannels: [
          {
            channelID,
            channelKey,
            name,
            visibility: 'public',
            createdAt: new Date().toISOString(),
          },
        ],
        subscriptions: [],
        updatedAt: new Date().toISOString(),
      }
      await putRecord(
        'settings',
        'self',
        enc.encode(
          await encryptSettings(
            await deriveSettingsKey(appKey),
            JSON.stringify(settings),
          ),
        ),
      )

      // The namespace the loop will serve this channel under, so the subscriber's
      // import can be checked against it. Opening is idempotent — the loop imports the
      // same namespace from the same derived seed.
      const seed = await deriveChannelDocSeed(appKey, channelID)
      const nsId = await openChannelDoc(
        Array.from(seed)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(''),
      )

      // Now let the real loop do the work, and wait until it says it advertised.
      const passes: string[] = []
      await startChannelDocLoop(hex, (report) => passes.push(report))
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const advertised = passes.some((p) => {
          try {
            return (JSON.parse(p) as { advertised?: number }).advertised
          } catch {
            return false
          }
        })
        if (advertised) break
        await new Promise((r) => setTimeout(r, 250))
      }
      return JSON.stringify({ channelID, channelKey, nsId, passes, cachedHead })
    },
    subscribe: async (
      channelID: string,
      channelKey: string,
      hexOverride?: string,
      cachedHead?: string,
    ) => {
      const hex = hexOverride ?? (await session()).hex
      if (!hex) return 'not signed in'
      const { encryptSettings, deriveSettingsKey } = await import(
        './core/crypto'
      )
      const { SETTINGS_VERSION } = await import('./core/settings')
      const { openDocs, putRecord, getRecord, startChannelSyncLoop } =
        await import('./lib/docs')
      const { decodeChannelManifest } = await import('./lib/channelLocator')
      const { channelKeyFromBase64 } = await import('./core/crypto')

      await openDocs(hex)
      // What a subscribe leaves behind — the loop reads this to learn who to watch.
      const settings = {
        version: SETTINGS_VERSION,
        myChannels: [],
        subscriptions: [
          {
            authorHandle: '',
            authorDID: '',
            channelID,
            channelKey,
            addedAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      }
      await putRecord(
        'settings',
        'self',
        new TextEncoder().encode(
          await encryptSettings(
            await deriveSettingsKey(Uint8Array.fromHex(hex)),
            JSON.stringify(settings),
          ),
        ),
      )

      // What the pull loop leaves behind after reading the channel from Sia, which is
      // where the content key the ticket is found under comes from. Only once: a poll
      // that re-seeded it would bury a manifest already pushed.
      if (cachedHead && !(await getRecord('sub', channelID))) {
        await putRecord('sub', channelID, new TextEncoder().encode(cachedHead))
      }

      const passes: string[] = []
      await startChannelSyncLoop(hex, (report) => passes.push(report))

      // The loop writes a pushed manifest to `sub/<channelID>` — the same record the
      // polling rung writes — so that record is where the proof is. Reading it back
      // and opening it with K shows the manifest travelled the whole way.
      const deadline = Date.now() + 90_000
      let name: string | null = null
      while (Date.now() < deadline && name === null) {
        const stored = await getRecord('sub', channelID)
        if (stored) {
          try {
            const manifest = await decodeChannelManifest(
              channelKeyFromBase64(channelKey),
              stored,
            )
            name = manifest.name
          } catch {
            // Entry present, content not downloaded yet — look again.
          }
        }
        if (name === null) await new Promise((r) => setTimeout(r, 500))
      }
      return JSON.stringify({ name, passes })
    },
  }
  // Write a probe record and wait for the Curator to mirror it. Taking the snapshot
  // here would make this a second writer of the one artifact the whole account rests
  // on, which is precisely what moving it into the Curator removed.
  // A hydration says which of three things it found, so a diagnostic that used to print
  // a count stops reading "0 records" for a snapshot nobody could reach.
  const describeHydration = (o: {
    kind: string
    records?: number
    error?: string
  }): string =>
    o.kind === 'restored'
      ? `${o.records} record(s)`
      : o.kind === 'none'
        ? 'no snapshot published'
        : `UNREADABLE (${o.error})`

  g.__pinMirrorWrite = async (text: string) => {
    const { hex } = await session()
    if (!hex) return 'not signed in'
    const { openDocs, putRecord } = await import('./lib/docs')
    await openDocs(hex)
    await putRecord('probe', 'persist', new TextEncoder().encode(text))
    return 'written; the Curator mirrors it on its next pass'
  }
  g.__pinMirrorRead = async () => {
    const { client, hex } = await session()
    if (!client || !hex) return 'not signed in'
    const { openDocs, getRecord } = await import('./lib/docs')
    const { hydrateFromSia } = await import('./lib/docsMirror')
    await openDocs(hex)
    const n = describeHydration(await hydrateFromSia(client, hexToBytes(hex)))
    const v = await getRecord('probe', 'persist')
    return `hydrated ${n}; probe/persist = ${v ? new TextDecoder().decode(v) : 'MISSING'}`
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
    const n = describeHydration(await hydrateFromSia(client, hexToBytes(hex)))
    const raw = await getRecord('settings', 'self')
    if (!raw) return `hydrated ${n}; no settings/self in the doc yet`
    const key = await deriveSettingsKey(hexToBytes(hex))
    const s = JSON.parse(
      await decryptSettings(key, new TextDecoder().decode(raw)),
    )
    return `hydrated ${n}; settings/self: ${s.myChannels?.length ?? 0} channels, ${s.subscriptions?.length ?? 0} subs, theme=${s.theme}`
  }
  // What's in the doc after hydrating from Sia? Lists every record key
  // (settings/self, published/<id>, ...) — the durability check for whatever the
  // doc currently holds.
  g.__pinDocsList = async () => {
    const { client, hex } = await session()
    if (!client || !hex) return 'not signed in'
    const { openDocs, listAll } = await import('./lib/docs')
    const { hydrateFromSia } = await import('./lib/docsMirror')
    await openDocs(hex)
    const n = describeHydration(await hydrateFromSia(client, hexToBytes(hex)))
    const keys = await listAll()
    return `hydrated ${n}:\n${keys.map((k) => `  ${k.collection}/${k.rkey}`).join('\n')}`
  }
  // What the boot restore did, WITHOUT doing one.
  //
  // `__pinDocsList` above hydrates before it lists, which is the right shape for asking
  // whether a snapshot can be read and exactly the wrong one for asking whether the boot
  // already read it: a failed restore would be repaired by the act of looking, and then
  // report a full doc. So this reads state and writes nothing.
  //
  // Three outcomes a filled-or-empty heart cannot tell apart. `pending` is a restore
  // still in flight or one that never started; `unknown` is a snapshot that would not
  // read, which holds the publishing loops deliberately and is the state that looks like
  // the app being broken rather than careful; `ready` over an empty `endorse/` means the
  // restore ran and had nothing to put back, which is a different answer from a restore
  // that was skipped.
  g.__pinRestoreDiag = async () => {
    const { hex } = await session()
    if (!hex) return 'not signed in'
    const out: string[] = []

    // The desktop's doc is a redb store, so there is nothing to restore and the hook
    // reports ready having read nothing. Say so, or a healthy desktop reads as a restore
    // that was skipped.
    out.push(
      inTauri()
        ? 'platform: desktop — durable doc, restore is a no-op'
        : 'platform: web — MemStore, the doc is rebuilt from the snapshot each session',
    )

    const { useCuratorStore } = await import('./stores/curator')
    const cs = useCuratorStore.getState()
    out.push(
      `docRestore: ${cs.docRestore}${
        cs.docRestore === 'unknown'
          ? ` — ${cs.lastError ?? '(no error recorded)'}`
          : ''
      }`,
    )

    // What the doc holds now, by collection. `endorse/` is the one the restore exists
    // for: the identity loop assembles a directory from it, and an absence there is
    // published as a withdrawal.
    // Bounded, because the doc may not be open — on the naming screen the restore is
    // still deciding, and a read that waits on it hangs the whole report. An instrument
    // that can hang cannot report, and the line it would have printed is worth less than
    // knowing the read did not come back.
    const withTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T> =>
      await Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
        ),
      ])

    try {
      const { listAll } = await import('./lib/docs')
      const keys = await withTimeout(listAll(), 5000)
      const byCollection = new Map<string, number>()
      for (const k of keys) {
        byCollection.set(
          k.collection,
          (byCollection.get(k.collection) ?? 0) + 1,
        )
      }
      const counts = [...byCollection]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([c, n]) => `${c}=${n}`)
        .join(' ')
      out.push(`doc: ${keys.length} record(s)${counts ? ` — ${counts}` : ''}`)
      for (const k of keys.filter((k) => k.collection === 'endorse')) {
        out.push(`  endorse/${k.rkey}`)
      }
    } catch (e) {
      out.push(`doc: ${e instanceof Error ? e.message : e}`)
    }

    // The other half, and why a missing endorsement is not automatically a bug: a record
    // this identity withdrew is skipped by the restore on purpose, and stays skipped
    // until the snapshot stops carrying it.
    const { withdrawnAddresses } = await import('./lib/withdrawn')
    const withdrawn = withdrawnAddresses()
    out.push(`withdrawn ledger: ${withdrawn.size}`)
    for (const a of withdrawn) out.push(`  ${a}`)

    return out.join('\n')
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
    const fakeAppKey = crypto.getRandomValues(new Uint8Array(32))
    const throwaway = await deriveDidDht(fakeAppKey)
    // Publishing takes the SIGNING seed (the key itself stays in Rust), and that's the
    // HKDF output — not the AppKey bytes deriveDidDht was handed.
    const { deriveDidDhtSeed } = await import('./core/crypto')
    const signingSeed = await deriveDidDhtSeed(fakeAppKey)
    const value = `roundtrip-${Date.now()}`
    await publishRecords(signingSeed, [{ name: '_pin', value }])
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
    if (!auth.client || !auth.storedKeyHex || !ch)
      return 'no client / no owned channel'
    const manifest = useFeedStore.getState().manifests[ch.channelID]
    if (!manifest) return `manifest for ${ch.channelID} not loaded yet`
    const { publishChannelLocator, resolveChannelViaLocator } = await import(
      './lib/channelLocator'
    )
    const pub = await publishChannelLocator(
      auth.storedKeyHex,
      ch.channelKey,
      manifest,
    )
    const got = await resolveChannelViaLocator(ch.channelKey)
    const match =
      got?.name === manifest.name && got?.items.length === manifest.items.length
    return `locator ${pub.locatorKey.slice(0, 12)}… → reader resolved "${got?.name}" (${got?.items.length ?? 0}/${manifest.items.length} items) — ${match ? 'MATCH' : 'MISMATCH'}`
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
  // Why isn't a subscribed channel updating? Read-only, mutates nothing.
  //
  // Puts the three things that can disagree side by side, for every subscription:
  // what the pull loop CACHED, what its skip MARK says it last saw, and what the
  // locator resolves to RIGHT NOW. Which pair disagrees names the layer:
  //
  //   cached stale, live fresh  -> the pull loop isn't picking it up
  //   cached fresh, screen stale -> the cache updated and nothing re-rendered
  //   cached stale, live stale  -> the author's publish never reached the DHT
  //
  // The live read is a real network resolve, so it takes a few seconds per channel.
  g.__pinSubDiag = async () => {
    const { hex } = await session()
    if (!hex) return 'not signed in'
    const [
      { useAuthStore },
      { getRecord, openDocs },
      locator,
      { channelKeyFromBase64 },
    ] = await Promise.all([
      import('./stores/auth'),
      import('./lib/docs'),
      import('./lib/channelLocatorNative'),
      import('./core/crypto'),
    ])
    await openDocs(hex)
    const subs = useAuthStore.getState().subscriptions
    if (subs.length === 0) return '(no subscriptions)'

    // Newest publishedAt is what actually moves when a post lands, so it says more
    // than a count: an edit changes bytes without changing how many items there are.
    const describe = (json: string) => {
      try {
        const m = JSON.parse(json) as {
          items?: Array<{ publishedAt?: string }>
        }
        const items = m.items ?? []
        const newest = items
          .map((i) => i.publishedAt ?? '')
          .sort()
          .pop()
        return `${items.length} items, newest ${newest || '(none)'}`
      } catch (e) {
        return `unreadable: ${e}`
      }
    }

    const lines: string[] = []
    for (const sub of subs) {
      const k = channelKeyFromBase64(sub.channelKey)
      lines.push(`${sub.cachedName ?? sub.channelID} (${sub.channelID})`)

      const cached = await getRecord('sub', sub.channelID)
      lines.push(
        `  cached: ${
          cached
            ? describe(
                await locator.openBlob(k, new TextDecoder().decode(cached)),
              )
            : '(no sub/ record)'
        }`,
      )

      const mark = await getRecord('pull', sub.channelID)
      lines.push(
        `  mark:   ${mark ? new TextDecoder().decode(mark) : '(no pull/ mark)'}`,
      )

      try {
        const live = await locator.resolveLocator(k)
        lines.push(
          `  live:   ${live ? describe(live.manifestJson) : '(locator resolves to nothing)'}`,
        )
      } catch (e) {
        lines.push(`  live:   FAILED ${e}`)
      }
    }
    return lines.join('\n')
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
  // Why an endorsement hasn't been delivered. Runs one real delivery pass and reports
  // every decision it made — the target it worked out, how many endpoints that identity
  // advertises, how many of those say enough to dial, and what became of the knock. Each
  // of those failing leaves the same trace as never having tried, which is nothing.
  g.__pinDeliverProbe = async () => {
    const { inTauri } = await import('./lib/openExternal')
    if (!inTauri()) return 'desktop only (run in the Pin desktop app)'
    const { useAuthStore } = await import('./stores/auth')
    const hex = useAuthStore.getState().storedKeyHex
    if (!hex) return 'not signed in'
    const { deliverProbeNative } = await import('./lib/tauriDocs')
    return deliverProbeNative(hex)
  }
  // Why your own profile page won't load. Walks the EXACT chain HandleDirectory walks —
  // did:dht → the pkarr packet → the `_dir` pointer → the Sia download — and reports what
  // each hop said, next to what this identity thinks it last published. A failure at any
  // hop reads the same on the page ("object not found"), and the three causes want
  // different fixes: a stale record nothing has overwritten yet, a publish state naming a
  // deleted blob (so the fingerprint says "unchanged" and it never re-uploads), or an
  // identity with nothing to advertise, which publishes nothing at all.
  g.__pinDirDiag = async () => {
    const { client, hex } = await session()
    if (!client || !hex) return 'not signed in'
    const out: string[] = []

    const { deriveDidDht, reassembleTxt } = await import('./lib/pkarr')
    const { did } = await deriveDidDht(hexToBytes(hex))
    out.push(`did: ${did}`)

    // What the DHT (native) or the relays (web) currently serve under that key.
    const { pkarrTransport } = await import('./lib/pkarrTransport')
    let records: { name: string; value: string }[] = []
    try {
      records = await (await pkarrTransport()).resolve(did)
    } catch (e) {
      out.push(`pkarr resolve THREW: ${e instanceof Error ? e.message : e}`)
    }
    out.push(
      `pkarr records (${records.length}): ${records.map((r) => r.name).join(', ') || '(none)'}`,
    )
    const url = await reassembleTxt(records, '_dir')
    out.push(`_dir: ${url ?? 'ABSENT — nothing published under this key'}`)

    // What the identity loop believes it published. When its fingerprint matches the
    // directory it would assemble, it reuses this URL instead of uploading — so a dead
    // object here is a state that repairs itself never.
    const { readPublished } = await import('./lib/publishState')
    // `fp` is written by the Rust identity loop and isn't in the frontend's own type;
    // this reads a record another writer produces.
    const held = (await readPublished(hex, 'directory')) as {
      id: string
      url?: string
      fp?: string
    } | null
    out.push(
      held
        ? `published/directory: id=${held.id} fp=${held.fp ?? '(none)'}
  url=${held.url ?? '(none)'}
  matches _dir: ${held.url === url}`
        : 'published/directory: (no record — the loop has not published since the last reset)',
    )

    // The hop that actually errors on the page.
    if (url) {
      try {
        const bytes = await client.downloadItem(url)
        const doc = JSON.parse(new TextDecoder().decode(bytes))
        out.push(
          `download: OK, ${bytes.length} bytes, version=${doc?.version}, ${doc?.channels?.length ?? 0} channel(s), profile=${doc?.profile?.username ?? '(none)'}`,
        )
      } catch (e) {
        out.push(`download FAILED: ${e instanceof Error ? e.message : e}`)
        // Is the object simply gone from this scope, or is it a fetch that failed?
        try {
          const id = await client.resolveObjectID(url)
          const held = await client.getObjectSlabs(id)
          out.push(
            `  object ${id}: ${held ? 'present in this scope' : 'NOT HELD'}`,
          )
        } catch (e2) {
          out.push(
            `  resolveObjectID: ${e2 instanceof Error ? e2.message : e2}`,
          )
        }
      }
    }

    // The identity loop's own last word, which says whether it published this pass and
    // what it carried. Nothing here at all means the loop has not completed a pass.
    try {
      const { curatorStatus } = await import('./lib/curator')
      const st = await curatorStatus()
      out.push(
        `curator: running=${st.running} identity=${st.didDhtPublished ?? '(no pass reported)'}`,
      )
    } catch (e) {
      out.push(`curator status: ${e instanceof Error ? e.message : e}`)
    }

    // Whether there is anything to publish at all — an identity with no profile, no
    // advertised channels, no follows and no endorsements publishes nothing, which leaves
    // whatever the DHT already held standing until it expires.
    const { useAuthStore } = await import('./stores/auth')
    const st = useAuthStore.getState()
    out.push(
      `local: profile=${st.profile?.username ?? '(none)'} channels=${st.myChannels?.length ?? 0} subs=${st.subscriptions?.length ?? 0}`,
    )
    return out.join('\n')
  }
  // What the crawl has read, and who it would read next.
  //
  // The index is state that no log can show you: a pass reports what it DID, and the
  // question after a live run is what it is now sitting on — how much of the network is
  // held, how much of it has faded past being findable, and whether the order it will read
  // in makes sense. `Pin.log` on desktop already carries the pass outcomes (`curator
  // discover:` lines), so nothing here duplicates them.
  //
  // The frontier is computed by THE REAL RUST FUNCTION the loop uses, over this identity's
  // actual records, so the order printed is the order the next pass will take rather than a
  // second implementation that agrees with it on a good day.
  g.__pinDiscoverDiag = async (howMany = 10) => {
    const { hex } = await session()
    if (!hex) return 'not signed in'
    const out: string[] = []

    const { listDirectories } = await import('./lib/directories')
    const held = await listDirectories(hex)

    // Tier is the number that says how much of what is held is still USABLE: a faded record
    // keeps the way back to somebody and nothing else, so it is in the index without being
    // findable, resolvable for a name, or walkable for its edges.
    const tiers = { full: 0, reduced: 0, minimal: 0, untiered: 0 }
    let withProfile = 0
    let channels = 0
    for (const { record } of held) {
      const tier = record.tier ?? 'untiered'
      tiers[tier as keyof typeof tiers] =
        (tiers[tier as keyof typeof tiers] ?? 0) + 1
      if (record.profile) withProfile++
      channels += record.channels?.length ?? 0
    }
    out.push(`held: ${held.length}`)
    out.push(
      `  tiers: full=${tiers.full} reduced=${tiers.reduced} minimal=${tiers.minimal}${tiers.untiered ? ` untiered=${tiers.untiered}` : ''}`,
    )
    out.push(`  searchable: ${withProfile} profile(s), ${channels} channel(s)`)

    // This identity's own graph, which the crawl deliberately does NOT read: the engagement
    // crawl covers exactly that set, and two loops on two cadences would race to write one
    // record and pay the lookup twice. Own did included — anyone in your graph who follows
    // one of your channels names YOU as an edge.
    //
    // This has to agree with `covered_elsewhere` in `pin-curator` — `graph_actors` over
    // follows, handle-follows and subscriptions, plus own did — or the order printed below
    // is not the order the next pass takes, and an instrument that disagrees with the thing
    // it is measuring is worse than none. The same two-languages hazard `advertisedChannels`
    // carries.
    const { useAuthStore } = await import('./stores/auth')
    const st = useAuthStore.getState()
    const r0 = new Set<string>(st.myDidDht ? [st.myDidDht] : [])
    for (const f of st.follows ?? []) r0.add(f.didDht)
    for (const h of st.handleFollows ?? []) r0.add(h)
    for (const sub of st.subscriptions ?? []) {
      // `didDht` is absent on a legacy handle subscription, which the crawl then has no
      // did to exclude by — and reporting one it cannot name would be worse than not
      // counting it.
      if (sub.didDht) r0.add(sub.didDht)
    }
    out.push(`covered by the engagement crawl (not read here): ${r0.size}`)

    const { listRecords } = await import('./lib/docs')
    const { request_collection } = await import(
      '../crates/pin-core/pkg/pin_core.js'
    )
    let requests: string[] = []
    try {
      requests = await listRecords(request_collection())
    } catch {
      // A listing that will not open is not an absence of requests, so say so rather than
      // reporting zero.
      out.push('requests: COULD NOT READ')
    }
    out.push(
      `requests outstanding: ${requests.length}${requests.length ? ` — ${requests.slice(0, 5).join(', ')}` : ''}`,
    )

    // The real ordering function, over the real records.
    const { ensureWasm } = await import('./core/wasm')
    await ensureWasm()
    const { discovery_frontier, discovery_budget, discovery_refresh_share } =
      await import('../crates/pin-core/pkg/pin_core.js')
    const edges: Record<string, string[]> = {}
    for (const { didDht, record } of held) {
      edges[didDht] = [
        ...(record.follows ?? []).map((f) => f.didDht),
        ...(record.handleFollows ?? []),
      ]
    }
    const candidates: {
      did: string
      distance: number
      references: number
      requested: boolean
    }[] = JSON.parse(
      discovery_frontier(
        JSON.stringify([...r0]),
        JSON.stringify(edges),
        JSON.stringify(requests),
      ),
    )
    const budget = discovery_budget()
    const reserved = discovery_refresh_share()
    out.push(`frontier: ${candidates.length} known to exist and never read`)
    out.push(
      `budget: ${budget} resolves a pass, ${reserved} reserved for re-reading held records`,
    )
    // Why each sits where it does, which is the half a count cannot answer. UNREACHED is
    // u32::MAX — held some other way (a portal, a knock) with no distance from the graph.
    for (const [i, c] of candidates.slice(0, howMany).entries()) {
      const distance =
        c.distance === 0xffffffff ? 'unreached' : `${c.distance} hop(s)`
      out.push(
        `  ${i + 1}. ${c.did}${c.requested ? ' [REQUESTED]' : ''} ${distance}, ${c.references} reference(s)`,
      )
    }
    if (candidates.length > howMany) {
      out.push(`  … and ${candidates.length - howMany} more`)
    }
    out.push(
      'pass outcomes: `curator discover:` lines in Pin.log (desktop); the loop does not report into the tab',
    )
    return out.join('\n')
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
    const docChanges: Array<{
      collection: string
      rkey: string
      kind: string
    }> = []
    const pullPasses: string[] = []
    const keepAlivePasses: string[] = []
    const channelDocPasses: string[] = []
    const channelSyncPasses: string[] = []
    const instancePasses: string[] = []
    const identityPasses: string[] = []
    const engagementPasses: string[] = []
    const deliverPasses: string[] = []
    const rendezvousPasses: string[] = []
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
      // The Curator's rendezvous loop, running in this tab — the real one the app
      // starts, not a harness reimplementation of it. Symmetric, so both sides call
      // this: each advertises where it can be reached and connects to whoever it
      // finds, and no ticket is copied by hand.
      startRendezvous: async (hex) => {
        await (await docs()).openDocs(hex)
        await (await docs()).startRendezvousLoop(hex, (report) => {
          rendezvousPasses.push(report)
        })
        return 'started'
      },
      rendezvousPasses: () => rendezvousPasses.slice(),
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
      // The doc-change feed (docs.ts subscribeDocChanges): what the engine reports
      // moved in this identity's doc. Recorded so a spec can assert a peer's write
      // was ANNOUNCED, not merely readable — the difference between the feed working
      // and the reader having polled its way there.
      watchChanges: async () => {
        ;(await docs()).subscribeDocChanges((c) => {
          docChanges.push(c)
        })
        return 'watching'
      },
      changes: () => docChanges.slice(),
      // The Curator's pull loop, running in this tab. Pass reports are recorded so a
      // spec can prove the loop TURNS — a pass that reports (even an error) is a pass
      // that ran, which is the property a missing wasm executor would silently deny.
      startPull: async (hex) => {
        await (await docs()).openDocs(hex)
        await (await docs()).startPullLoop(hex, (report) => {
          pullPasses.push(report)
        })
        return 'started'
      },
      passes: () => pullPasses.slice(),
      // Same, for the locator keep-alive loop — a second loop from the same crate, so
      // the property worth proving is the same one: that it turns.
      startKeepAlive: async (hex) => {
        await (await docs()).openDocs(hex)
        await (await docs()).startKeepAliveLoop(hex, (report) => {
          keepAlivePasses.push(report)
        })
        return 'started'
      },
      keepAlivePasses: () => keepAlivePasses.slice(),
      // Same, for the channel-doc serve loop. It reads what this identity owns, so an
      // empty doc stops it at the same place the other reading loops stop.
      startChannelDocs: async (hex) => {
        await (await docs()).openDocs(hex)
        await (await docs()).startChannelDocLoop(hex, (report) => {
          channelDocPasses.push(report)
        })
        return 'started'
      },
      channelDocPasses: () => channelDocPasses.slice(),
      // And the subscriber counterpart, which reads the subscription list from the
      // same place — so an empty doc stops it in the same spot.
      startChannelSync: async (hex) => {
        await (await docs()).openDocs(hex)
        await (await docs()).startChannelSyncLoop(hex, (report) => {
          channelSyncPasses.push(report)
        })
        return 'started'
      },
      channelSyncPasses: () => channelSyncPasses.slice(),
      // And the instance-registration loop. Unlike the other two this one SUCCEEDS on
      // an empty doc — it writes its own registration rather than reading anything —
      // so the spec can assert the real outcome instead of a reached-the-doc error.
      startInstance: async (hex) => {
        await (await docs()).openDocs(hex)
        await (await docs()).startInstanceLoop((report) => {
          instancePasses.push(report)
        })
        return 'started'
      },
      instancePasses: () => instancePasses.slice(),
      // And the identity publisher. Like the other reading loops it stops at an empty
      // doc, which is the proof available without credentials: a real pass uploads.
      startIdentity: async (hex) => {
        const ns = await (await docs()).openDocs(hex)
        await (await docs()).startIdentityLoop(hex, ns, (report) => {
          identityPasses.push(report)
        })
        return 'started'
      },
      identityPasses: () => identityPasses.slice(),
      // And the engagement crawl. Reads the identity's settings first to learn what it
      // publishes, so an empty doc stops it there — which is the proof available without
      // credentials, since a real pass downloads other people's directories from Sia.
      startEngagement: async (hex) => {
        await (await docs()).openDocs(hex)
        await (await docs()).startEngagementLoop(hex, (report) => {
          engagementPasses.push(report)
        })
        return 'started'
      },
      engagementPasses: () => engagementPasses.slice(),
      // And delivery. Also settings-first — it needs the subscription list to work out
      // who an unlisted endorsement is about — so an empty doc stops it there, which is
      // the proof available without a peer to knock.
      startDeliver: async (hex) => {
        await (await docs()).openDocs(hex)
        await (await docs()).startDeliverLoop(hex, (report) => {
          deliverPasses.push(report)
        })
        return 'started'
      },
      deliverPasses: () => deliverPasses.slice(),
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
