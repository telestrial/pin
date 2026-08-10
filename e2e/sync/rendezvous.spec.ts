// The rendezvous loop — how two instances of ONE identity find each other without a
// ticket being copied by hand. Each publishes where it can be reached to a pkarr record
// under an AppKey-derived (hence private) key, and syncs with whoever it finds there.
//
// Drives the REAL loop (crates/pin-curator, via docs.ts startRendezvousLoop) rather than
// a harness reimplementation of it, so what passes here is the path the app runs. It
// also proves the loop TURNS on wasm: a task with no executor doesn't error, it stays
// pending forever, so a pass that reports is the property worth asserting.
//
// SYMMETRIC — both tabs start the same loop. Neither is the host.
//
// A per-run RANDOM app key → a fresh rendezvous key each run, so the resolve is a
// first-read (no stale-relay-cache lag from overwriting a prior run's record — see
// CLAUDE.md pkarr-relay-read-after-write). Both tabs use the SAME random key => same
// identity (namespace) AND same rendezvous key.

import { randomBytes } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'

type SyncHarness = {
  open: (hex: string) => Promise<string>
  startRendezvous: (hex: string) => Promise<string>
  rendezvousPasses: () => string[]
  put: (c: string, k: string, v: string) => Promise<void>
  get: (c: string, k: string) => Promise<string | null>
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
      { timeout: 120_000, intervals: [500] },
    )
    .toBe(want)
}

test('two instances find each other through the rendezvous record (no manual ticket)', async ({
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

  // Both start the same loop. Nothing is exchanged between the tabs by the test —
  // each only knows the shared key.
  await a.evaluate((hex) => window.__pinSync!.startRendezvous(hex), HEX)
  await b.evaluate((hex) => window.__pinSync!.startRendezvous(hex), HEX)

  // The loop turned, in a browser. A pass reporting at all is the property a missing
  // wasm executor would silently deny.
  await expect
    .poll(() => a.evaluate(() => window.__pinSync!.rendezvousPasses().length), {
      timeout: 60_000,
      intervals: [500],
    })
    .toBeGreaterThan(0)

  // And it reached the network: advertising means the ticket and the directory entry
  // were both published, which is what makes this instance findable at all.
  await expect
    .poll(
      () =>
        a.evaluate(() =>
          window
            .__pinSync!.rendezvousPasses()
            .some((p) => JSON.parse(p).advertised === true),
        ),
      { timeout: 90_000, intervals: [1000] },
    )
    .toBe(true)

  // Bidirectional convergence over the auto-discovered connection — the payoff. One
  // side finding the other is enough: an import reconciles both directions.
  await a.evaluate(() => window.__pinSync!.put('probe', 'from-a', 'hi-a'))
  await waitForValue(b, 'probe', 'from-a', 'hi-a')
  await b.evaluate(() => window.__pinSync!.put('probe', 'from-b', 'hi-b'))
  await waitForValue(a, 'probe', 'from-b', 'hi-b')

  console.log(
    '[rz] a passes:',
    await a.evaluate(() => window.__pinSync!.rendezvousPasses()),
  )

  await context.close()
})
