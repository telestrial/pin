// E2E happy-path: alice creates a channel and publishes a post in her
// browser context; bob subscribes via URL in his context; bob's feed
// shows alice's post; bob pins alice's whole channel (real cross-account
// sharedObject + pinObject fan-out into his Sia scope) and unpins it.
//
// Runs against a built `dist/` served by `bun run preview --port 4173`,
// using real Sia hosts + real bsky.social. The single test in this file
// is the reconciliation point for our fake-SDK contract — if the fake
// drifts from real SDK behavior, this test fails and we fix the fake.
//
// Auth happens per-test via signInAccount() (~5s each). See
// e2e/authHelper.ts for why we're not using storageState fixtures.

import { expect, type Page, test } from '@playwright/test'
import { loadAccount, signInAccount } from '../authHelper'

test('alice publishes a post; bob subscribes via URL and sees it', async ({
  browser,
}) => {
  // Both contexts need clipboard permission so we can capture alice's
  // subscribe URL (the post-create UI only exposes it via "Copy" → clipboard).
  const aliceContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const bobContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  })

  // Surface page-side errors so init failures (Builder.connected throws,
  // OAuth refresh fails, etc.) show up in the test output instead of
  // silently failing later locators.
  for (const [label, ctx] of [
    ['alice', aliceContext],
    ['bob', bobContext],
  ] as const) {
    ctx.on('weberror', (e) => console.log(`[${label} weberror]`, e.error()))
  }

  // Hoisted so the finally block can clean up whatever this run created,
  // even if an assertion in the middle fails partway through.
  let alice: Page | undefined
  let channelName: string | undefined

  try {
    alice = await signInAccount(aliceContext, loadAccount('alice'))
    const bob = await signInAccount(bobContext, loadAccount('bob'))

    // -- Alice creates a channel --

    // Sidebar button — always present once Sia is connected; welcome
    // "Create a channel" only renders for fresh empty-feed accounts and
    // alice may have accumulated state from prior runs.
    await alice.getByRole('button', { name: '+ Create a channel' }).click()

    channelName = `e2e test ${Date.now()}`
    await alice.getByPlaceholder(/e\.g\. John Williams/i).fill(channelName)
    await alice.getByRole('button', { name: /Create channel/i }).click()

    await expect(
      alice.getByRole('heading', { name: /Channel created/i }),
    ).toBeVisible({ timeout: 60_000 })

    await alice.getByRole('button', { name: /Copy subscribe URL/i }).click()
    const subscribeURL = await alice.evaluate(() =>
      navigator.clipboard.readText(),
    )
    expect(subscribeURL).toMatch(/^pin:\/\//)

    await alice.getByRole('button', { name: /^Done$/ }).click()

    // -- Alice publishes a post --

    const postBody = `Hello from alice — ${Date.now()}`
    await alice.getByPlaceholder(/What are you thinking about/i).fill(postBody)
    await alice.getByRole('button', { name: /^Publish$/ }).click()

    await expect(alice.getByText(postBody)).toBeVisible({ timeout: 90_000 })

    // -- Bob subscribes via URL --

    await bob.getByRole('button', { name: '+ Subscribe' }).click()

    await expect(
      bob.getByRole('heading', { name: /Subscribe to a channel/i }),
    ).toBeVisible()
    await bob.getByPlaceholder(/pin:\/\//i).fill(subscribeURL)
    // Two "Subscribe" buttons exist (sidebar + form submit); the form
    // submit is the exact "Subscribe", the sidebar is "+ Subscribe".
    await bob.getByRole('button', { name: 'Subscribe', exact: true }).click()

    // Bob's feed populates via the encrypted ATProto record fetch + Sia bytes.
    await expect(bob.getByText(postBody)).toBeVisible({ timeout: 90_000 })
    // Channel name appears in two places (sidebar subscribed-channels entry
    // AND feed-row channel header); .first() picks whichever resolves.
    await expect(bob.getByText(channelName).first()).toBeVisible()

    // -- Bob pins alice's whole channel, then unpins it --
    //
    // The real cross-account fan-out: pinning the channel mirrors every
    // item's bytes into bob's OWN Sia scope via sharedObject + pinObject;
    // unpin-all releases them. This is the reconciliation proof for the
    // channel-pin fan-out (the integration tier runs the same flow against
    // the fakes). Bob cleans up his own mirror here, before alice's channel
    // is retracted in finally, so neither account accumulates state.

    // Open alice's channel from bob's subscribed list. Structural scope to
    // the left Sidebar via its unique Home button — the channel name also
    // appears in feed rows and the right PinSidebar.
    const bobSidebar = bob.locator('aside').filter({
      has: bob.getByRole('button', { name: 'Home', exact: true }),
    })
    await bobSidebar
      .locator('ul[aria-label="Subscribed channels"]')
      .getByRole('button', { name: channelName })
      .click({ timeout: 30_000 })

    // Pinnable → click → the icon flips to the pinned state once every
    // item's bytes have mirrored into bob's scope. (Item PinButtons read
    // "Pin to your storage"; the channel button is "Pin this channel…".)
    const pinChannel = bob.getByTitle(/Pin this channel to your storage/)
    await expect(pinChannel).toBeVisible({ timeout: 30_000 })
    await pinChannel.click()
    await expect(bob.getByTitle(/Unpin this channel/)).toBeVisible({
      timeout: 90_000,
    })

    // Custody is real and persisted: bob's snapshot lives in his own
    // pinStore (localStorage), independent of alice's channel record.
    const pinnedCount = await bob.evaluate((key) => {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw).state?.pinned?.length ?? 0) : 0
    }, 'sia-pins-f6b7539e181e45ee')
    expect(pinnedCount).toBeGreaterThan(0)

    // Unpin-all (behind the confirm modal) releases bob's mirrored bytes
    // and returns the icon to pinnable — cleaning up after this run.
    await bob.getByTitle(/Unpin this channel/).click()
    await bob.getByRole('button', { name: 'Unpin all' }).click()
    await expect(
      bob.getByTitle(/Pin this channel to your storage/),
    ).toBeVisible({ timeout: 90_000 })
  } finally {
    // Retract alice's channel so the next run starts clean. Cleanup runs
    // even when assertions fail, so e2e never leaves leftover ATProto
    // records or Sia bytes accumulating in alice's account. Wrapped in
    // its own try so cleanup failures don't mask the original test
    // failure they followed.
    if (alice && channelName) {
      try {
        await cleanupAliceChannel(alice, channelName)
      } catch (e) {
        console.warn('[alice channel cleanup] failed:', e)
      }
    }
    await aliceContext.close()
    await bobContext.close()
  }
})

// Drives alice's "Unpin channel" UI to retract the run's channel. The
// production unpinChannel path walks every item via deleteObject, deletes
// the manifest record, and calls pruneSlabs — same housekeeping a real
// retract performs.
async function cleanupAliceChannel(page: Page, channelName: string) {
  // Operate from wherever alice's last test action left her — typically
  // home with sidebar mounted. We intentionally don't page.goto('/')
  // because the auth helper's addInitScript reseeds myChannels=[] on
  // every fresh document load, racing the settings-sync that has to
  // repopulate from Sia before the sidebar entry appears.
  //
  // Two "Your channels" lists exist on home — Sidebar (left) and
  // PinSidebar (right). Scope structurally via Sidebar's unique "Home"
  // button rather than DOM order. Then narrow to the "Your channels"
  // UL inside it, because owners auto-subscribe to their own channels
  // and the same channel name appears in Sidebar's "Subscribed
  // channels" list too.
  const sidebar = page.locator('aside').filter({
    has: page.getByRole('button', { name: 'Home', exact: true }),
  })
  const yourChannels = sidebar.locator('ul[aria-label="Your channels"]')
  await yourChannels
    .getByRole('button', { name: channelName })
    .click({ timeout: 30_000 })
  // window.prompt() is a native browser dialog in Playwright — accept
  // with the required typed DELETE before clicking, so the click's
  // prompt picks up the response.
  page.once('dialog', (dialog) => dialog.accept('DELETE'))
  await page.getByRole('button', { name: 'Unpin channel' }).click()
  await expect(yourChannels.getByText(channelName)).toBeHidden({
    timeout: 60_000,
  })
}
