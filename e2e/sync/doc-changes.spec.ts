// The doc-change feed — the "state out" half of repo-as-only-contract.
//
// A consumer shouldn't have to ask whether a record moved. This proves the engine
// TELLS it: two tabs of one identity sync, one writes, and the other's feed reports
// the change with the record decomposed into (collection, rkey) — the shape the
// frontend routes on.
//
// The distinction being tested is announcement, not readability. sync-loopback
// already shows the value arrives; this shows something SAID SO, which is what lets
// the settings overlay (and, next, the pull loop) drop its timer.
//
// Credential-free like the rest of this tier: openDocs is pure HKDF + an iroh bind,
// so a fixed key makes two tabs into two nodes of one identity.

import { expect, type Page, test } from '@playwright/test'

type DocChange = { collection: string; rkey: string; kind: string }

type SyncHarness = {
  open: (hex: string) => Promise<string>
  share: () => Promise<string>
  sync: (ticket: string) => Promise<void>
  put: (c: string, k: string, v: string) => Promise<void>
  watchChanges: () => Promise<string>
  changes: () => DocChange[]
}
declare global {
  interface Window {
    __pinSync?: SyncHarness
  }
}

async function harness(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => !!window.__pinSync, null, { timeout: 30_000 })
}

function changes(page: Page): Promise<DocChange[]> {
  return page.evaluate(() => window.__pinSync!.changes())
}

test('a peer write is announced on the doc-change feed, split into collection + rkey', async ({
  browser,
}) => {
  // A fresh identity per run, so nothing a previous run left in a replica can be
  // mistaken for this run's announcement.
  const appKeyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const context = await browser.newContext()
  const a = await context.newPage()
  const b = await context.newPage()

  try {
    await harness(a)
    await harness(b)

    const [nsA, nsB] = await Promise.all([
      a.evaluate((hex) => window.__pinSync!.open(hex), appKeyHex),
      b.evaluate((hex) => window.__pinSync!.open(hex), appKeyHex),
    ])
    expect(nsA).toBe(nsB)

    // Watch BEFORE syncing, so the reconciliation that carries A's write can't land
    // in the gap between the two.
    await b.evaluate(() => window.__pinSync!.watchChanges())

    // Let both endpoints reach the relay first. `share` snapshots whatever addresses
    // are known at that instant, and a ticket minted cold carries none — B would then
    // have nothing to dial (no discovery in the browser), never join the swarm, and
    // never be pushed A's write. The symptom is a feed that reports the local
    // reconciliation and then goes quiet.
    await a.waitForTimeout(3000)

    const ticket = await a.evaluate(() => window.__pinSync!.share())
    await b.evaluate((t) => window.__pinSync!.sync(t), ticket)

    await a.evaluate(() => window.__pinSync!.put('probe', 'from-a', 'hello'))

    // The record event, decomposed. `insert-remote` specifically: B must be told a
    // PEER wrote, which is what distinguishes it from B's own writes (the settings
    // overlay filters on exactly this, or it would bounce its own writes back out).
    await expect
      .poll(() => changes(b), { timeout: 90_000, intervals: [500] })
      .toContainEqual({
        collection: 'probe',
        rkey: 'from-a',
        kind: 'insert-remote',
      })

    // A local write is reported too, and reported as local — the engine is faithful
    // and the FILTERING is the consumer's job. If these two collapsed to one kind,
    // every consumer would echo its own writes.
    await b.evaluate(() => window.__pinSync!.put('probe', 'from-b', 'there'))
    await expect
      .poll(() => changes(b), { timeout: 30_000, intervals: [250] })
      .toContainEqual({
        collection: 'probe',
        rkey: 'from-b',
        kind: 'insert-local',
      })

    // Stream-level events carry empty strings rather than a mangled key — the signal
    // a consumer reads as "something landed, re-check". content-ready is the one that
    // matters (iroh-blobs content lags its entry), and it names no key.
    const all = await changes(b)
    for (const c of all) {
      if (c.collection === '') expect(c.rkey).toBe('')
      else expect(c.rkey).not.toBe('')
    }
  } finally {
    await context.close()
  }
})
