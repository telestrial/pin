// E2E author-side smoke — the single-account happy path that runs GREEN today,
// on real Sia + the public Mainline DHT (pkarr), with no cross-user read.
//
// Why this exists: the three cross-account specs are test.fixme'd behind the
// browser pkarr read-after-write lag (a relay-cache boundary the browser can't
// beat — see CLAUDE.md 2026-07-23). That left the whole e2e tier green-but-hollow.
// This restores REAL coverage of the parts that DON'T depend on a fresh cross-user
// resolve: onboarding (did:dht from the seeded Sia AppKey), channel creation (a
// real Sia manifest upload + pkarr locator publish), the composer + upload runner
// / action journal, the author's own feed render (local state, no DHT read), and
// channel retract (the drain path). Single session — no reload, since a reload
// would re-resolve the locator off the lagging relays and reintroduce the boundary.
//
// Deliberately does NOT assert any cross-account or post-reload visibility; those
// stay covered against fakes in the integration tier and fixme'd in e2e until an
// always-on node / iroh-docs live-sync is in the loop.

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
