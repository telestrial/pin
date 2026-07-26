// Slice 2 — rendezvous auto-discovery. Instead of copying a DocTicket by hand, one
// instance PUBLISHES its ticket to a pkarr record under the AppKey-derived rendezvous
// key, and the other RESOLVES it and syncs — no manual exchange. Proves the
// auto-discovery mechanism end-to-end over the real DHT/relays.
//
// A per-run RANDOM app key → a fresh rendezvous key each run, so the resolve is a
// first-read (no stale-relay-cache lag from overwriting a prior run's record — see
// CLAUDE.md pkarr-relay-read-after-write). Both tabs use the SAME random key => same
// identity (namespace) AND same rendezvous key.

import { randomBytes } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'

type SyncHarness = {
  open: (hex: string) => Promise<string>
  rendezvousPublish: (hex: string) => Promise<string>
  rendezvousConnect: (hex: string) => Promise<string>
  put: (c: string, k: string, v: string) => Promise<void>
  get: (c: string, k: string) => Promise<string | null>
  events: () => string[]
}
declare global {
  interface Window {
    __pinSync?: SyncHarness
  }
}

async function harness(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => !!window.__pinSync, null, {
    timeout: 30_000,
  })
}

async function waitForValue(page: Page, c: string, k: string, want: string) {
  await expect
    .poll(
      () => page.evaluate(({ c, k }) => window.__pinSync!.get(c, k), { c, k }),
      { timeout: 90_000, intervals: [500] },
    )
    .toBe(want)
}

test('two instances auto-connect via the rendezvous record (no manual ticket)', async ({
  browser,
}) => {
  // Fresh key per run — same for both tabs (same identity + same rendezvous key).
  const HEX = randomBytes(32).toString('hex')

  const context = await browser.newContext()
  context.on('weberror', (e) => console.log('[rz weberror]', e.error()))

  const a = await context.newPage()
  const b = await context.newPage()
  await harness(a)
  await harness(b)

  await a.evaluate((hex) => window.__pinSync!.open(hex), HEX)
  await b.evaluate((hex) => window.__pinSync!.open(hex), HEX)

  // A publishes its ticket to the rendezvous record (DHT/relay, ~seconds).
  await a.evaluate((hex) => window.__pinSync!.rendezvousPublish(hex), HEX)

  // B auto-connects: resolve the rendezvous record → ticket → startSync. No manual
  // exchange happened — B only knows the shared key. (Retries past propagation lag.)
  const synced = await b.evaluate(
    (hex) => window.__pinSync!.rendezvousConnect(hex),
    HEX,
  )
  expect(synced.length).toBeGreaterThan(0)

  // Bidirectional convergence over the auto-discovered connection.
  await a.evaluate(() => window.__pinSync!.put('probe', 'from-a', 'hi-a'))
  await waitForValue(b, 'probe', 'from-a', 'hi-a')
  await b.evaluate(() => window.__pinSync!.put('probe', 'from-b', 'hi-b'))
  await waitForValue(a, 'probe', 'from-b', 'hi-b')

  console.log('[rz] b events:', await b.evaluate(() => window.__pinSync!.events()))

  await context.close()
})
