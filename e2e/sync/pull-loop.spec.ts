// The Curator's loops, running in a browser tab.
//
// What this proves is narrow and specific: the loop TURNS. It starts, completes a
// pass, and reports it — on the wasm target, through the same Rust the desktop
// Curator runs.
//
// That's worth a spec because of how this fails. A shared crate that compiles for
// wasm can still never run there: an async task needs an executor, and when one is
// missing the future doesn't error, it stays pending forever. Nothing throws, nothing
// logs, the loop simply never happens (see CLAUDE.md, step 3's `spawn_local` hang).
// A pass that reports is the cheapest possible evidence against that.
//
// It does NOT prove a pass resolves channels — that needs Sia credentials, which this
// tier deliberately doesn't have. Here the pass fails, and its failure is the proof:
// reaching "no settings record yet" means the loop read the doc and came back.

import { expect, type Page, test } from '@playwright/test'

type SyncHarness = {
  startPull: (hex: string) => Promise<string>
  passes: () => string[]
  startKeepAlive: (hex: string) => Promise<string>
  keepAlivePasses: () => string[]
  startInstance: (hex: string) => Promise<string>
  instancePasses: () => string[]
  startIdentity: (hex: string) => Promise<string>
  identityPasses: () => string[]
  startChannelDocs: (hex: string) => Promise<string>
  channelDocPasses: () => string[]
  startChannelSync: (hex: string) => Promise<string>
  channelSyncPasses: () => string[]
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

test('the pull loop runs a pass in the browser and reports it', async ({
  page,
}) => {
  // A fresh identity, so the doc is empty and the first pass has a known outcome.
  const appKeyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  await harness(page)
  await page.evaluate((hex) => window.__pinSync!.startPull(hex), appKeyHex)

  await expect
    .poll(() => page.evaluate(() => window.__pinSync!.passes()), {
      timeout: 60_000,
      intervals: [250],
    })
    .not.toHaveLength(0)

  // An empty doc has no settings record, so the pass has nothing to read a
  // subscription list out of. Reporting that is the loop working, not failing: it
  // got as far as the doc and returned an answer rather than hanging.
  const [first] = await page.evaluate(() => window.__pinSync!.passes())
  expect(JSON.parse(first)).toEqual({ error: 'no settings record yet' })
})

test('the keep-alive loop runs a pass in the browser and reports it', async ({
  page,
}) => {
  const appKeyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  await harness(page)
  await page.evaluate((hex) => window.__pinSync!.startKeepAlive(hex), appKeyHex)

  await expect
    .poll(() => page.evaluate(() => window.__pinSync!.keepAlivePasses()), {
      timeout: 60_000,
      intervals: [250],
    })
    .not.toHaveLength(0)

  // Same shape as the pull loop's proof, and for the same reason: the keep-alive reads
  // the identity's settings to learn what it owns, so an empty doc stops it there. That
  // it reports at all is the evidence — a loop with no executor would just never speak.
  const [first] = await page.evaluate(() =>
    window.__pinSync!.keepAlivePasses(),
  )
  expect(JSON.parse(first)).toEqual({ error: 'no settings record yet' })
})

test('the instance loop registers this tab as a live endpoint', async ({
  page,
}) => {
  const appKeyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  await harness(page)
  await page.evaluate((hex) => window.__pinSync!.startInstance(hex), appKeyHex)

  await expect
    .poll(() => page.evaluate(() => window.__pinSync!.instancePasses()), {
      timeout: 60_000,
      intervals: [250],
    })
    .not.toHaveLength(0)

  // This loop writes rather than reads, so an empty doc is no obstacle: it registers
  // itself and counts itself live. One live instance is a tab that put its own dial
  // coordinates where its other devices can see them, which is the whole job.
  const [first] = await page.evaluate(() => window.__pinSync!.instancePasses())
  expect(JSON.parse(first)).toEqual({ live: 1, pruned: 0 })
})

test('the identity loop runs a pass in the browser and reports it', async ({
  page,
}) => {
  const appKeyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  await harness(page)
  await page.evaluate((hex) => window.__pinSync!.startIdentity(hex), appKeyHex)

  await expect
    .poll(() => page.evaluate(() => window.__pinSync!.identityPasses()), {
      timeout: 60_000,
      intervals: [250],
    })
    .not.toHaveLength(0)

  // A real pass uploads a directory blob to Sia, which this tier has no credentials
  // for — so the reachable proof is the same one the other reading loops give: it got
  // to the doc, found no settings, and said so instead of hanging.
  const [first] = await page.evaluate(() => window.__pinSync!.identityPasses())
  expect(JSON.parse(first)).toEqual({ error: 'no settings record yet' })
})

test('the channel-doc serve loop runs a pass in the browser and reports it', async ({
  page,
}) => {
  const appKeyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  await harness(page)
  await page.evaluate(
    (hex) => window.__pinSync!.startChannelDocs(hex),
    appKeyHex,
  )

  await expect
    .poll(() => page.evaluate(() => window.__pinSync!.channelDocPasses()), {
      timeout: 60_000,
      intervals: [250],
    })
    .not.toHaveLength(0)

  // Serving a channel means opening a second replica, minting a ticket and publishing
  // it to the DHT — none of which this pass reaches, because it reads the identity's
  // settings first to learn which channels are its own. Stopping there and saying so
  // is the evidence: the loop ran on the wasm target rather than hanging in a task
  // with no executor.
  const [first] = await page.evaluate(() =>
    window.__pinSync!.channelDocPasses(),
  )
  expect(JSON.parse(first)).toEqual({ error: 'no settings record yet' })
})

test('the channel live-sync loop runs a pass in the browser and reports it', async ({
  page,
}) => {
  const appKeyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  await harness(page)
  await page.evaluate((hex) => window.__pinSync!.startChannelSync(hex), appKeyHex)

  await expect
    .poll(() => page.evaluate(() => window.__pinSync!.channelSyncPasses()), {
      timeout: 60_000,
      intervals: [250],
    })
    .not.toHaveLength(0)

  // Importing a channel means resolving its author's ticket off the DHT, which this
  // pass never reaches: it reads the subscription list first, and an empty doc has
  // none. Saying so is the proof that it ran at all.
  const [first] = await page.evaluate(() =>
    window.__pinSync!.channelSyncPasses(),
  )
  expect(JSON.parse(first)).toEqual({ error: 'no settings record yet' })
})

test('the engagement loop runs a pass in the browser and reports it', async ({
  page,
}) => {
  const appKeyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  await harness(page)
  await page.evaluate(
    (hex) => window.__pinSync!.startEngagement(hex),
    appKeyHex,
  )

  await expect
    .poll(() => page.evaluate(() => window.__pinSync!.engagementPasses()), {
      timeout: 60_000,
      intervals: [250],
    })
    .not.toHaveLength(0)

  // A real pass resolves the graph's did:dhts and downloads their directory blobs from
  // Sia, which this tier has no credentials for. So the reachable proof is the same one
  // the other reading loops give: it got to the doc, found no settings, and said so
  // rather than hanging in a task with no executor — which is the failure a crate that
  // merely COMPILES for wasm still has.
  const [first] = await page.evaluate(() =>
    window.__pinSync!.engagementPasses(),
  )
  expect(JSON.parse(first)).toEqual({ error: 'no settings record yet' })
})

test('the delivery loop runs a pass in the browser and reports it', async ({
  page,
}) => {
  const appKeyHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  await harness(page)
  await page.evaluate((hex) => window.__pinSync!.startDeliver(hex), appKeyHex)

  await expect
    .poll(() => page.evaluate(() => window.__pinSync!.deliverPasses()), {
      timeout: 60_000,
      intervals: [250],
    })
    .not.toHaveLength(0)

  // A tab dials as well as a desktop, so delivery is the same loop here — and this is
  // what proves it actually RUNS on this target rather than merely compiling for it: a
  // task with no executor stays pending forever, silently. It reads the subscription
  // list first (to work out who an unlisted endorsement is about), so an empty doc stops
  // it there, which is the answer available without a peer to knock.
  const [first] = await page.evaluate(() => window.__pinSync!.deliverPasses())
  expect(JSON.parse(first)).toEqual({ error: 'no settings record yet' })
})
