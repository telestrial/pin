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

import { test } from '@playwright/test'
import { drainE2EChannels, loadAccount, signInAccount } from '../authHelper'

test('drain all "e2e test" channels from alice', async ({ browser }) => {
  test.skip(!process.env.E2E_DRAIN, 'set E2E_DRAIN=1 to run this maintenance task')
  test.setTimeout(10 * 60 * 1000)

  const context = await browser.newContext()
  context.on('weberror', (e) => console.log('[alice weberror]', e.error()))
  const alice = await signInAccount(context, loadAccount('alice'))

  // Bulk variant of the per-test cleanup: a large iteration cap and a budget
  // just under the test timeout, so one invocation drains as many as it can.
  // Each retract is durable (settings flush on removal), so progress persists
  // across runs — re-run until it reports 0 drained.
  const drained = await drainE2EChannels(alice, {
    max: 40,
    budgetMs: 9 * 60 * 1000,
  })
  console.log(`[drain] done — drained ${drained} channels this run`)
  await context.close()
})
