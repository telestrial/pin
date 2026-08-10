// Ladder rung 1, end to end: an author serves a channel as a live doc, and a
// subscriber finds it from the channel key ALONE and gets the manifest pushed into
// its feed.
//
// The difference from channel-doc.spec.ts: nothing is handed over out of band. The
// author publishes a read ticket to a pkarr record under a K-derived key; the
// subscriber derives the same key from K, resolves the ticket off the real Mainline
// DHT, imports it, and stores what arrives. Reading the manifest's name back out —
// through K — is what proves the whole path rather than just that a sync began.
//
// BOTH SIDES ARE PRODUCTION CODE — the Curator's own loops, on both ends. Each side
// seeds the doc the way the app would (the author: a sealed manifest under
// `channel/<id>` plus a settings record naming the channel as owned; the subscriber: a
// settings record naming it as subscribed) and then starts the real loop. A harness that
// served or imported the channel itself would be a second implementation of the thing
// under test, and would keep passing after the real one broke.
//
// The subscriber's proof is `sub/<channelID>` — the record the loop writes, and the same
// one the polling rung writes, opened with K. Landing it in the feed from there is the
// change feed's job and is covered separately.
//
// The channel key is minted fresh per run, so the DHT read is a FIRST read rather than
// an overwrite — public relays lag badly on overwrites (CLAUDE.md 2026-07-23), and
// that lag is a property of the relays, not something a client can beat.
//
// No Sia and no auth: publishing here writes the manifest into the doc and the ticket
// to the DHT, neither of which touches Sia. (A real publish also commits a Sia object
// + locator; that's the durable rung below, covered elsewhere.)

import { expect, type Page, test } from '@playwright/test'

const APP_KEY_HEX = 'd0c5'.repeat(16) // 64 hex chars

type LiveHarness = {
  publish: (name: string, hexOverride?: string) => Promise<string>
  subscribe: (
    channelID: string,
    channelKey: string,
    hexOverride?: string,
  ) => Promise<string>
}
declare global {
  interface Window {
    __pinChannelDocLive?: LiveHarness
  }
}

async function harness(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => !!window.__pinChannelDocLive, null, {
    timeout: 30_000,
  })
}

test('a subscriber finds a channel from its key and is pushed the manifest', async ({
  browser,
}) => {
  const context = await browser.newContext()
  context.on('weberror', (e) => console.log('[rung1 weberror]', e.error()))

  const author = await context.newPage()
  const subscriber = await context.newPage()
  await harness(author)
  await harness(subscriber)

  // Let the author's endpoint reach a relay before it mints a ticket — a ticket
  // minted cold carries no dialable address (the finding from the seam slice).
  await author.waitForTimeout(3000)

  const published = JSON.parse(
    await author.evaluate(
      (hex) => window.__pinChannelDocLive!.publish('Rung One', hex),
      APP_KEY_HEX,
    ),
  ) as { channelID: string; channelKey: string; nsId: string; passes: string[] }
  console.log('[rung1] published:', published)
  expect(published.nsId.length).toBeGreaterThan(0)

  // The subscriber gets ONLY what a real subscribe URL carries: the channel key (and
  // the channelID, itself derived from that key). It has to find the author via the
  // DHT. Poll, because a fresh pkarr publish takes seconds to become resolvable.
  let result: { name: string | null; passes: string[] } = {
    name: null,
    passes: [],
  }
  await expect
    .poll(
      async () => {
        result = JSON.parse(
          await subscriber.evaluate(
            ({ id, key, hex }) =>
              window.__pinChannelDocLive!.subscribe(id, key, hex),
            {
              id: published.channelID,
              key: published.channelKey,
              hex: APP_KEY_HEX,
            },
          ),
        )
        return result.name
      },
      { timeout: 120_000, intervals: [3000] },
    )
    .toBe('Rung One')

  console.log('[rung1] subscriber:', result)

  await context.close()
})
