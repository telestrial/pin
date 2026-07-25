// Slice 1a — iroh-docs sync loopback across two browser tabs.
//
// Proves the app's OWN sync verbs (docs.ts shareDoc / startSync, over pin-core's
// wasm engine) converge two replicas of the SAME identity, BIDIRECTIONALLY, over
// the n0 relay — with a browser tab as the ticket PRODUCER (serving node). No
// desktop, no Sia, no auth: openDocs derives the namespace from the AppKey hex via
// HKDF and binds an iroh endpoint, so the hex is a fixed constant and the same on
// both tabs — they're two nodes of one identity. This is the mechanism the
// browser<->Curator slice (1b) builds on; the point is that a browser tab that's
// open is a full node (it serves the ticket), not a reader tier.

import { expect, type Page, test } from '@playwright/test'

// Any 32 bytes; open() is pure HKDF, never touches Sia. Same on both tabs => same
// namespace + author => two replicas of one identity.
const APP_KEY_HEX = '5eed'.repeat(16) // 64 hex chars

type SyncHarness = {
  open: (hex: string) => Promise<string>
  share: () => Promise<string>
  sync: (ticket: string) => Promise<void>
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

// Poll get() until it returns the expected value. Content lags RBSR metadata in
// iroh-blobs, so the value materializes a beat after the key syncs (get() returns
// null until the blob lands — see the harness).
async function waitForValue(page: Page, c: string, k: string, want: string) {
  await expect
    .poll(
      () => page.evaluate(({ c, k }) => window.__pinSync!.get(c, k), { c, k }),
      { timeout: 90_000, intervals: [500] },
    )
    .toBe(want)
}

test('two browser tabs of one identity converge bidirectionally', async ({
  browser,
}) => {
  const context = await browser.newContext()
  context.on('weberror', (e) => console.log('[sync weberror]', e.error()))

  const a = await context.newPage()
  const b = await context.newPage()
  await harness(a)
  await harness(b)

  // Both tabs open the SAME identity's doc (same hex => same namespace + author).
  const nsA = await a.evaluate((hex) => window.__pinSync!.open(hex), APP_KEY_HEX)
  const nsB = await b.evaluate((hex) => window.__pinSync!.open(hex), APP_KEY_HEX)
  expect(nsA).toBe(nsB) // same identity => same namespace id

  // Give both endpoints a moment to reach the relay so the shared ticket carries a
  // dialable address.
  await a.waitForTimeout(3000)

  // Tab A SERVES (produces the ticket); tab B dials it and starts syncing. That a
  // browser tab is the producer is the point — it's a full node, not a reader.
  const ticket = await a.evaluate(() => window.__pinSync!.share())
  expect(ticket.length).toBeGreaterThan(0)
  await b.evaluate((t) => window.__pinSync!.sync(t), ticket)

  // A -> B: write on the serving tab, the dialing tab receives it.
  await a.evaluate(() =>
    window.__pinSync!.put('probe', 'from-a', 'hello-from-a'),
  )
  await waitForValue(b, 'probe', 'from-a', 'hello-from-a')

  // B -> A: the reverse direction over the same connection (sync is symmetric —
  // one import reconciles both ways).
  await b.evaluate(() =>
    window.__pinSync!.put('probe', 'from-b', 'hello-from-b'),
  )
  await waitForValue(a, 'probe', 'from-b', 'hello-from-b')

  console.log('[sync] a events:', await a.evaluate(() => window.__pinSync!.events()))
  console.log('[sync] b events:', await b.evaluate(() => window.__pinSync!.events()))

  await context.close()
})
