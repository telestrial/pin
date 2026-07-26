// Dev-only cross-device sync harness — a tap-driven UI over docs.ts's sync verbs,
// so two devices (desktop Chrome + a phone's Chrome) can prove iroh-docs live-sync
// with no console and no USB. Reached at `#synctest` (see main.tsx), gated
// DEV || inTauri and lazy-loaded so it never enters a prod bundle.
//
// Flow for two devices: both Open the same key (same identity => same namespace),
// one taps Share and hands the ticket to the other (Copy + "Send to your devices",
// or paste), the other pastes it and taps Sync. One import reconciles both ways —
// then a Put on either device shows up in the other's live Records list within
// seconds. Pure iroh: no Sia, no sign-in. openDocs derives the namespace from the
// key via HKDF and binds an iroh endpoint (relay-only in a browser).

import { useEffect, useState } from 'react'
import {
  getRecord,
  listAll,
  openDocs,
  putRecord,
  shareDoc,
  startSync,
} from '../../lib/docs'
import { autoConnectRendezvous, publishRendezvous } from '../../lib/rendezvous'

// Any 32 bytes; openDocs is pure HKDF. The same value on both devices => the same
// namespace + author => two replicas of one identity.
const DEFAULT_HEX = '5eed'.repeat(16)

export function SyncTestPanel() {
  const [hex, setHex] = useState(DEFAULT_HEX)
  const [namespace, setNamespace] = useState<string | null>(null)
  const [myTicket, setMyTicket] = useState('')
  const [peerTicket, setPeerTicket] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [records, setRecords] = useState<string[]>([])
  const [putKey, setPutKey] = useState('hello')
  const [putVal, setPutVal] = useState('world')
  const [getKey, setGetKey] = useState('hello')
  const [getVal, setGetVal] = useState<{ v: string | null } | null>(null)
  const [log, setLog] = useState<string[]>([])

  const say = (m: string) =>
    setLog((l) =>
      [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 30),
    )

  // Once the doc is open, poll the record list so cross-device writes appear live
  // (no manual Get needed to see convergence).
  useEffect(() => {
    if (!namespace) return
    let cancelled = false
    const tick = async () => {
      try {
        const all = await listAll()
        if (!cancelled)
          setRecords(all.map((k) => `${k.collection}/${k.rkey}`).sort())
      } catch {
        /* engine may be mid-rebuild */
      }
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [namespace])

  const doOpen = async () => {
    try {
      const ns = await openDocs(hex)
      setNamespace(ns)
      say(`opened — namespace ${ns}`)
    } catch (e) {
      say(`open failed: ${e}`)
    }
  }
  const [rzBusy, setRzBusy] = useState(false)
  const doRzPublish = async () => {
    try {
      await publishRendezvous(hex)
      say('published rendezvous — the other device can auto-connect now')
    } catch (e) {
      say(`rendezvous publish failed: ${e}`)
    }
  }
  const doRzConnect = async () => {
    setRzBusy(true)
    try {
      await autoConnectRendezvous(hex, (l) =>
        setEvents((ev) => [l, ...ev].slice(0, 50)),
      )
      say('auto-connected via rendezvous — no ticket copied')
    } catch (e) {
      say(`auto-connect failed: ${e}`)
    } finally {
      setRzBusy(false)
    }
  }
  const doShare = async () => {
    try {
      const t = await shareDoc()
      setMyTicket(t)
      say(`shared a ticket (${t.length} chars) — hand it to the other device`)
    } catch (e) {
      say(`share failed: ${e}`)
    }
  }
  const doSync = async () => {
    const t = peerTicket.trim()
    if (!t) return say('paste a peer ticket first')
    try {
      await startSync(t, (l) => setEvents((ev) => [l, ...ev].slice(0, 50)))
      say('sync started — watch Events for neighbor-up + sync-finished')
    } catch (e) {
      say(`sync failed: ${e}`)
    }
  }
  const doPut = async () => {
    try {
      await putRecord('probe', putKey, new TextEncoder().encode(putVal))
      say(`put probe/${putKey} = ${putVal}`)
    } catch (e) {
      say(`put failed: ${e}`)
    }
  }
  const doGet = async () => {
    try {
      const b = await getRecord('probe', getKey)
      setGetVal({ v: b ? new TextDecoder().decode(b) : null })
    } catch {
      // content lags metadata — null means "not here yet", tap again
      setGetVal({ v: null })
    }
  }
  const copy = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v)
      say('copied to clipboard')
    } catch {
      say('copy failed — select the text and copy manually')
    }
  }

  const btn =
    'px-4 py-3 rounded-md text-base font-medium bg-green-600 text-white active:bg-green-700 disabled:opacity-50'
  const input =
    'w-full px-3 py-2.5 rounded-md border border-neutral-300 text-base font-mono'
  const card = 'border border-neutral-200 rounded-lg p-4 space-y-3'

  return (
    <div className="min-h-screen bg-neutral-100 p-4">
      <div className="max-w-xl mx-auto space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900">Sync test</h1>
          <p className="text-xs text-neutral-500">
            Two devices, one identity — prove iroh-docs live-sync.
          </p>
        </div>

        <section className={card}>
          <div className="text-sm font-semibold text-neutral-700">
            1 · Open (both devices, same key)
          </div>
          <input
            className={input}
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            spellCheck={false}
          />
          <button type="button" className={btn} onClick={doOpen}>
            Open
          </button>
          {namespace && (
            <div className="text-xs text-neutral-600 break-all">
              namespace:{' '}
              <span className="font-mono text-neutral-900">{namespace}</span>
              <div className="text-neutral-400">
                (must match on both devices)
              </div>
            </div>
          )}
        </section>

        <section className={card}>
          <div className="text-sm font-semibold text-neutral-700">
            2 · Auto-connect (rendezvous) — no ticket
          </div>
          <div className="text-xs text-neutral-500">
            One device Publishes its coords to the shared rendezvous record; the
            other Auto-connects — resolves it and syncs, no copy. Same key ⇒
            same rendezvous record.
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className={btn}
              onClick={doRzPublish}
              disabled={!namespace}
            >
              Publish rendezvous
            </button>
            <button
              type="button"
              className={btn}
              onClick={doRzConnect}
              disabled={!namespace || rzBusy}
            >
              {rzBusy ? 'Connecting…' : 'Auto-connect'}
            </button>
          </div>
        </section>

        <section className={card}>
          <div className="text-sm font-semibold text-neutral-700">
            2b · Connect manually — Share / paste ticket
          </div>
          <button
            type="button"
            className={btn}
            onClick={doShare}
            disabled={!namespace}
          >
            Share (this device serves)
          </button>
          {myTicket && (
            <div className="space-y-2">
              <textarea
                className={`${input} h-24`}
                readOnly
                value={myTicket}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                className="px-3 py-2 rounded-md text-sm bg-neutral-200 text-neutral-800 active:bg-neutral-300"
                onClick={() => copy(myTicket)}
              >
                Copy ticket
              </button>
            </div>
          )}
          <div className="pt-1 text-sm text-neutral-600">
            …or paste the other device's ticket:
          </div>
          <textarea
            className={`${input} h-24`}
            placeholder="paste peer ticket here"
            value={peerTicket}
            onChange={(e) => setPeerTicket(e.target.value)}
            spellCheck={false}
          />
          <button
            type="button"
            className={btn}
            onClick={doSync}
            disabled={!namespace}
          >
            Sync (join the other device)
          </button>
        </section>

        <section className={card}>
          <div className="text-sm font-semibold text-neutral-700">
            3 · Write — appears on the other device
          </div>
          <div className="flex gap-2">
            <input
              className={input}
              value={putKey}
              onChange={(e) => setPutKey(e.target.value)}
              placeholder="key"
            />
            <input
              className={input}
              value={putVal}
              onChange={(e) => setPutVal(e.target.value)}
              placeholder="value"
            />
          </div>
          <button
            type="button"
            className={btn}
            onClick={doPut}
            disabled={!namespace}
          >
            Put probe/{putKey || '…'}
          </button>
        </section>

        <section className={card}>
          <div className="text-sm font-semibold text-neutral-700">
            Records (live)
          </div>
          {records.length === 0 ? (
            <div className="text-sm text-neutral-400">— none yet —</div>
          ) : (
            <ul className="space-y-0.5">
              {records.map((r) => (
                <li key={r} className="text-sm font-mono text-neutral-700">
                  {r}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2 pt-1">
            <input
              className={input}
              value={getKey}
              onChange={(e) => setGetKey(e.target.value)}
              placeholder="key"
            />
            <button
              type="button"
              className="px-4 py-2.5 rounded-md text-base bg-neutral-200 text-neutral-800 active:bg-neutral-300"
              onClick={doGet}
            >
              Get
            </button>
          </div>
          {getVal && (
            <div className="text-sm font-mono break-all">
              probe/{getKey} ={' '}
              {getVal.v === null ? (
                <span className="text-neutral-400">
                  (not here yet — tap Get again)
                </span>
              ) : (
                <span className="text-green-700">{getVal.v}</span>
              )}
            </div>
          )}
        </section>

        <section className={card}>
          <div className="text-sm font-semibold text-neutral-700">Events</div>
          {events.length === 0 ? (
            <div className="text-sm text-neutral-400">— none yet —</div>
          ) : (
            <ul className="space-y-0.5 max-h-40 overflow-y-auto">
              {events.map((e, i) => (
                <li key={i} className="text-xs font-mono text-neutral-600">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={card}>
          <div className="text-sm font-semibold text-neutral-700">Log</div>
          <ul className="space-y-0.5 max-h-40 overflow-y-auto">
            {log.map((m, i) => (
              <li key={i} className="text-xs font-mono text-neutral-500">
                {m}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
