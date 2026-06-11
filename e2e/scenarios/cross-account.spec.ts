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

    // Pinnable → click → fans out one pin per item. During the batch the
    // header pin fills bottom-up and the title reads "Pinning N/M…"; we
    // wait for the settled "Unpin this channel…" title that appears once
    // every item's bytes have mirrored into bob's scope. These regexes
    // target only the settled states — distinct from the transient
    // "Pinning…"/"Unpinning…" titles and from the item PinButtons'
    // "Pin/Unpin to your storage" — so the waits ride through the busy
    // window without false-matching.
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
    // Drain alice's e2e channels so the next run starts clean. Runs even
    // when assertions fail (so a failed run doesn't leave leftovers) and
    // whenever alice signed in (so it heals a prior backlog even if this
    // run failed before creating its own channel). Wrapped in its own try
    // so cleanup failures don't mask the original test failure.
    if (alice) {
      try {
        await cleanupE2EChannels(alice)
      } catch (e) {
        console.warn('[alice channel cleanup] failed:', e)
      }
    }
    await aliceContext.close()
    await bobContext.close()
  }
})

// Retract every channel this suite created — the current run's plus any
// leftovers from prior failed runs — so alice's account never accumulates.
// Matches by the "e2e test" name prefix every run uses, so it only ever
// touches this suite's channels, and loops because each delete navigates
// into the channel then back home (the sidebar list shrinks per pass).
//
// Why drain-all instead of the run's one channel: once a backlog builds
// up, the sidebar "Your channels" list caps at 10, so a single-channel
// cleanup could fail to find the current one and silently leave it —
// which is exactly how the backlog grew. Draining self-heals it.
async function cleanupE2EChannels(page: Page) {
  // Operate from wherever alice's last action left her — home with sidebar
  // mounted. We intentionally don't page.goto('/') because the auth
  // helper's addInitScript reseeds myChannels=[] on every fresh document
  // load, racing the settings-sync that repopulates from Sia.
  //
  // Two "Your channels" lists exist on home — Sidebar (left) and
  // PinSidebar (right). Scope structurally via Sidebar's unique "Home"
  // button. Owners auto-subscribe to their own channels, so the name also
  // appears in "Subscribed channels"; narrowing to the "Your channels" UL
  // avoids deleting via the wrong list.
  const sidebar = page.locator('aside').filter({
    has: page.getByRole('button', { name: 'Home', exact: true }),
  })
  const yourChannels = sidebar.locator('ul[aria-label="Your channels"]')

  // Safety cap — never loop unbounded against a real account.
  for (let i = 0; i < 20; i++) {
    const candidates = yourChannels.getByRole('button', { name: /e2e test/i })
    if ((await candidates.count()) === 0) break
    await candidates.first().click({ timeout: 30_000 })
    // window.prompt() is a native browser dialog in Playwright — accept it
    // with the required typed DELETE before the click that triggers it.
    page.once('dialog', (dialog) => dialog.accept('DELETE'))
    // The owned-channel retract is the filled pin icon in the header; its
    // accessible name comes from title="Unpin this channel" (the aria-hidden
    // glyph contributes nothing). Exact match so it can't collide with the
    // non-owned "Unpin this channel from your storage" pin.
    const unpinChannel = page.getByRole('button', {
      name: 'Unpin this channel',
      exact: true,
    })
    await unpinChannel.click()
    // The retract deletes the record + bytes, then navigates back to home,
    // so the channel page's Unpin button disappears. Wait for that before
    // re-querying the (now shorter) sidebar list.
    await expect(unpinChannel).toBeHidden({ timeout: 60_000 })
  }
}
