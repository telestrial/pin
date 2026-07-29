// Channel docs — the content-resolution ladder's top rung, end to end through the
// app's own seam (lib/docs.ts), across two real browser instances over the n0 relay.
//
// A channel doc is how a subscriber gets PUSHED an author's writes instead of polling
// the channel's pkarr locator and re-fetching from Sia. The author holds the write
// capability (from a seed only they can derive) and hands out a ShareMode::Read
// ticket; the subscriber imports that and live-syncs.
//
// What this proves that the Rust-side probe can't:
//   - one engine holds MORE than one doc (identity doc + a channel doc)
//   - the namespace-scoped CRUD works through docs.ts, not just in Rust
//   - a read ticket minted in a BROWSER is importable by another browser instance
//   - the read replica genuinely refuses a write, as seen from app code
//
// No Sia, no auth, no credentials: openDocs is pure HKDF + an iroh relay bind, so the
// AppKey hex is a fixed constant. Same tier as sync-loopback.spec.ts.

import { expect, type Page, test } from '@playwright/test'

// Any 32 bytes. Distinct from the loopback spec's key so the two specs can't collide
// on a shared namespace if they ever run in the same session.
const APP_KEY_HEX = 'ca11'.repeat(16) // 64 hex chars

type ChannelDocsHarness = {
  author: (hexOverride?: string) => Promise<string>
  subscriber: (ticket: string, hexOverride?: string) => Promise<string>
}
declare global {
  interface Window {
    __pinChannelDocs?: ChannelDocsHarness
  }
}

async function harness(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => !!window.__pinChannelDocs, null, {
    timeout: 30_000,
  })
}

test('an author serves a channel doc a second instance reads but cannot write', async ({
  browser,
}) => {
  const context = await browser.newContext()
  context.on('weberror', (e) => console.log('[channel-doc weberror]', e.error()))

  const author = await context.newPage()
  const subscriber = await context.newPage()
  await harness(author)
  await harness(subscriber)

  // --- Author half: open a channel doc, write into it, mint a read ticket. ---
  const authorReport = await author.evaluate(
    (hex) => window.__pinChannelDocs!.author(hex),
    APP_KEY_HEX,
  )
  console.log('[channel-doc] author:\n' + authorReport)

  // Multi-doc: a channel replica exists alongside this identity's own doc.
  expect(authorReport).toContain('channel ns    =')
  // Opening the same channel twice must reuse the replica, not rebuild it.
  expect(authorReport).toContain('reopen stable = yes')
  // Namespace-scoped write/read round-trip through the seam.
  expect(authorReport).toContain('get manifest  = ciphertext-v1')
  // Delete is scoped the same way.
  expect(authorReport).toContain('after delete  = undefined (ok)')

  const ticket = authorReport.split('\n').at(-1)!.trim()
  expect(ticket.length).toBeGreaterThan(0)

  // A ticket minted before the endpoint reaches a relay carries no dialable address,
  // so give the author a beat — the same reason the real publisher refreshes its
  // ticket rather than minting once.
  await author.waitForTimeout(3000)
  const freshTicket = (
    await author.evaluate((hex) => window.__pinChannelDocs!.author(hex), APP_KEY_HEX)
  )
    .split('\n')
    .at(-1)!
    .trim()

  // --- Subscriber half: import the read ticket, sync, and fail to write. ---
  const subReport = await subscriber.evaluate(
    ({ t, hex }) => window.__pinChannelDocs!.subscriber(t, hex),
    { t: freshTicket, hex: APP_KEY_HEX },
  )
  console.log('[channel-doc] subscriber:\n' + subReport)

  // The author's record reached the subscriber over the relay.
  expect(subReport).toContain('synced value = ciphertext-v2')
  // And the capability is genuinely read-only — the property the whole design rests
  // on, asserted from app code rather than from Rust.
  expect(subReport).toMatch(/write\s+= rejected:/)
  expect(subReport).not.toContain('NOT REJECTED')

  await context.close()
})
