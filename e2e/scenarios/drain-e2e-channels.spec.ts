// Maintenance utility, NOT part of the normal suite (guarded by E2E_DRAIN).
// Drains the alice account's accumulated "e2e test" channels — prior runs'
// in-finally cleanup hasn't kept up (it shares the test's time budget and
// gets cut off), so they pile up in Sia settings and slow/flaky every run.
//
// Run explicitly:
//   E2E_DRAIN=1 bunx playwright test drain-e2e-channels --project=chromium
//
// Each retract is durable (settings flush on removal), so progress persists
// across runs — re-run until it reports 0 remaining.

import { expect, test } from '@playwright/test'
import { loadAccount, signInAccount, waitForChannelsLoaded } from '../authHelper'

test('drain all "e2e test" channels from alice', async ({ browser }) => {
  test.skip(!process.env.E2E_DRAIN, 'set E2E_DRAIN=1 to run this maintenance task')
  test.setTimeout(10 * 60 * 1000)

  const context = await browser.newContext()
  context.on('weberror', (e) => console.log('[alice weberror]', e.error()))
  const alice = await signInAccount(context, loadAccount('alice'))

  // Wait for settings-sync to repopulate the channel list before counting —
  // otherwise we'd query the sidebar against the seeded-empty list and drain
  // nothing.
  await waitForChannelsLoaded(alice)

  const sidebar = alice.locator('aside').filter({
    has: alice.getByRole('button', { name: 'Home', exact: true }),
  })
  const yourChannels = sidebar.locator('ul[aria-label="Your channels"]')

  let drained = 0
  for (let i = 0; i < 40; i++) {
    const candidates = yourChannels.getByRole('button', { name: /e2e test/i })
    const count = await candidates.count()
    console.log(`[drain] pass ${i}: ${count} "e2e test" channels visible`)
    if (count === 0) break
    try {
      await candidates.first().click({ timeout: 30_000 })
      alice.once('dialog', (d) => d.accept('DELETE'))
      const unpin = alice.getByRole('button', {
        name: 'Unpin this channel',
        exact: true,
      })
      await unpin.click({ timeout: 30_000 })
      await expect(unpin).toBeHidden({ timeout: 120_000 })
      drained++
    } catch (e) {
      console.warn(`[drain] pass ${i} failed, recovering:`, e)
      // Get back to home so the next pass can re-query the sidebar.
      await alice
        .getByRole('button', { name: 'Home', exact: true })
        .first()
        .click({ timeout: 30_000 })
        .catch(() => {})
    }
  }
  console.log(`[drain] done — drained ${drained} channels this run`)
  await context.close()
})
