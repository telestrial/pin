// Drives the #synctest tap-panel end-to-end through its actual UI — the exact flow
// a person does across two devices (Open on both, Share on one, paste the ticket +
// Sync on the other, Put on one, see it in the other's live Records). Two pages
// stand in for the two devices; the test carries the ticket between them the way a
// person copies it. Proves the panel's buttons are wired to docs.ts's sync verbs
// before anyone drives it on a phone.

import { expect, test } from '@playwright/test'

test('the sync panel drives cross-page convergence through its UI', async ({
  browser,
}) => {
  const context = await browser.newContext()
  context.on('weberror', (e) => console.log('[panel weberror]', e.error()))

  const a = await context.newPage()
  const b = await context.newPage()
  for (const p of [a, b]) {
    await p.goto('/#synctest')
    await expect(
      p.getByRole('heading', { name: 'Sync test' }),
    ).toBeVisible()
    // Default hex is prefilled and identical → same namespace on both.
    await p.getByRole('button', { name: 'Open' }).click()
    await expect(p.getByText('namespace:')).toBeVisible({ timeout: 30_000 })
  }

  // Give both endpoints a moment to reach the relay so the shared ticket carries a
  // dialable address.
  await a.waitForTimeout(3000)

  // A serves: Share, then read the ticket out of its readonly textarea.
  await a.getByRole('button', { name: /Share/ }).click()
  const ticketBox = a.locator('textarea[readonly]')
  await expect(ticketBox).not.toHaveValue('', { timeout: 15_000 })
  const ticket = await ticketBox.inputValue()

  // B joins: paste the ticket and Sync (this is the person carrying it across).
  await b.getByPlaceholder('paste peer ticket here').fill(ticket)
  await b.getByRole('button', { name: /Sync/ }).click()

  // A writes probe/hello=world; B's live Records list should show it.
  await a.getByRole('button', { name: /^Put probe\// }).click()
  await expect(b.getByText('probe/hello', { exact: true })).toBeVisible({
    timeout: 90_000,
  })

  await context.close()
})
