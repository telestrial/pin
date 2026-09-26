// E2E author-side smoke — the single-account happy path, on real Sia and the real
// Mainline DHT reached through the pkarr relay on this machine, with no cross-user
// read.
//
// Why it exists alongside the cross-account specs: it is the only scenario whose
// failure is unambiguously the AUTHOR side. Everything it touches is one session and
// one identity — onboarding (did:dht from the seeded Sia AppKey), channel creation
// (a real Sia manifest upload + pkarr locator publish), the composer + upload runner
// / action journal, the author's own feed render (local state, no DHT read), and
// channel retract (the drain path). So when a cross-account spec fails, this one
// passing says the break is in the read, the resolve, or the other account, and this
// one failing says not to look there at all. That is what isolated bob's expired
// settings locator on 2026-09-25.
//
// Single session, no reload, and deliberately no cross-account or post-reload
// assertion — those belong to cross-account.spec.ts and granular-pin.spec.ts.

import { expect, type Page, test } from '@playwright/test'
import {
  createChannelButton,
  drainE2EChannels,
  loadAccount,
  signInAccount,
} from '../authHelper'

test('author: onboard, create a channel, publish a post, and see it', async ({
  browser,
}) => {
  const context = await browser.newContext()
  // Surface page-side init failures (Builder.connected throws, etc.) instead of
  // letting them fail a later locator silently.
  context.on('weberror', (e) => console.log('[alice weberror]', e.error()))

  let alice: Page | undefined
  let channelName: string | undefined
  try {
    // Seeded AppKey → the app restores the did:dht identity and lands on Home.
    alice = await signInAccount(context, loadAccount('alice'))

    // -- Create a channel --
    // Sidebar "+" (scoped; the empty-feed welcome renders a same-named CTA).
    await createChannelButton(alice).click()
    channelName = `e2e test ${Date.now()}`
    await alice.getByPlaceholder(/e\.g\. John Williams/i).fill(channelName)
    await alice.getByRole('button', { name: /Create channel/i }).click()
    // Create does two serial Sia uploads (manifest + settings snapshot) + a pkarr
    // publish before the confirmation, and Sia uploads churn through QUIC-failing
    // hosts — same generous budget the cross-account spec uses.
    await expect(
      alice.getByRole('heading', { name: /Channel created/i }),
    ).toBeVisible({ timeout: 150_000 })
    await alice.getByRole('button', { name: /^Done$/ }).click()

    // -- Publish a post --
    const postBody = `Author smoke — ${Date.now()}`
    await alice.getByPlaceholder(/What are you thinking about/i).fill(postBody)

    // The composer only renders a "Voice:" picker with >1 owned channel; on a
    // drained single-channel account the default voice is already the new one.
    // waitFor (not isVisible) — it renders a beat after fill() expands the composer.
    const voicePicker = alice.getByRole('button', { name: /^Voice:/ })
    const hasPicker = await voicePicker
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    if (hasPicker) {
      await voicePicker.click()
      await alice
        .getByRole('menuitem', { name: channelName })
        .click({ timeout: 10_000 })
    }
    await alice.getByRole('button', { name: /^Publish$/ }).click()

    // The author's own feed renders the post from local state after the upload
    // runner writes the manifest — no cross-user DHT resolve, so this is reliable
    // in-browser (unlike a subscriber read).
    await expect(alice.getByText(postBody)).toBeVisible({ timeout: 90_000 })
  } finally {
    // Retract this run's channel so the next run starts clean (also exercises the
    // channel-retract path). Runs even on failure; wrapped so cleanup errors don't
    // mask the test result.
    if (alice) {
      try {
        await drainE2EChannels(alice)
      } catch (e) {
        console.warn('[channel cleanup] failed:', e)
      }
    }
    await context.close()
  }
})
