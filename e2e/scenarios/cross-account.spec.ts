// E2E happy-path: alice creates a channel and publishes a post in her
// browser context; bob opens her link and watches the channel in his; bob's
// feed shows alice's post; bob pins alice's whole channel (real cross-account
// sharedObject + pinObject fan-out into his Sia scope) and unpins it.
//
// Runs against a built `dist/` served by `bun run preview --port 4173`,
// using real Sia hosts + the public Mainline DHT (pkarr). The single test
// in this file is the reconciliation point for our fake-SDK contract — if
// the fake drifts from real SDK behavior, this test fails and we fix the fake.
//
// Auth is per-test via signInAccount() — it just seeds the Sia AppKey and
// lets the app restore the did:dht identity. See e2e/authHelper.ts.

import { expect, type Page, test } from '@playwright/test'
import {
  createChannelButton,
  drainE2EChannels,
  drainE2ESubscriptions,
  loadAccount,
  refreshUntilVisible,
  signInAccount,
  followingList,
  openPinLinkButton,
  waitForChannelPublished,
} from '../authHelper'

test('alice publishes a post; bob opens her link, watches, and sees it', async ({
  browser,
}) => {
  // Re-enabled 2026-09-25. It was fixme'd because the PUBLIC pkarr relays lag on
  // read-after-write by their own 300s cache floor, which a publisher cannot argue
  // down — so bob could not resolve alice's just-published channel. The relays are
  // ours now, on a 1-5s TTL window, and `test:e2e` runs inside with-relays.sh.
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
  let bob: Page | undefined
  let channelName: string | undefined

  try {
    alice = await signInAccount(aliceContext, loadAccount('alice'))
    bob = await signInAccount(bobContext, loadAccount('bob'))

    // -- Alice creates a channel --

    // Sidebar "+" — always present once Sia is connected. Scoped to the
    // sidebar because the empty-feed welcome renders a button with the same
    // "Create a channel" name (see createChannelButton).
    await createChannelButton(alice).click()

    channelName = `e2e test ${Date.now()}`
    await alice.getByPlaceholder(/e\.g\. John Williams/i).fill(channelName)
    await alice.getByRole('button', { name: /Create channel/i }).click()

    // Generous: creating a channel now does two serial Sia uploads on the
    // critical path (the manifest object + the settings snapshot) plus a pkarr
    // publish, before the confirmation shows — vs the old atproto putRecord that
    // did none of that. Sia uploads churn through QUIC-failing hosts, so this
    // needs the same headroom the other Sia-touching waits have.
    await expect(
      alice.getByRole('heading', { name: /Channel created/i }),
    ).toBeVisible({ timeout: 150_000 })
    // The heading is the ENQUEUE, not the commit — see waitForChannelPublished.
    await waitForChannelPublished(alice, channelName)

    // Clear the clipboard BEFORE the copy, then poll for a fresh value.
    // `readText()` immediately after the click can return the PREVIOUS run's URL,
    // and matching /^pin:\/\// cannot tell a stale Pin link from a new one — so a
    // missed copy hands bob a link to a channel that no longer exists, and the
    // failure lands three steps later on a channel page that will not resolve.
    // Clearing makes the wait positive: the only thing that satisfies it is this
    // run's copy landing.
    await alice.evaluate(() => navigator.clipboard.writeText(''))
    await alice.getByRole('button', { name: /^Copy link$/i }).click()
    await expect
      .poll(async () => alice!.evaluate(() => navigator.clipboard.readText()), {
        timeout: 15_000,
      })
      .toMatch(/^pin:\/\//)
    const channelURL = await alice.evaluate(() =>
      navigator.clipboard.readText(),
    )

    await alice.getByRole('button', { name: /^Done$/ }).click()

    // -- Alice publishes a post --

    const postBody = `Hello from alice — ${Date.now()}`
    await alice.getByPlaceholder(/What are you thinking about/i).fill(postBody)

    // Pick the just-created channel as the voice. The composer defaults to
    // channels[0] — the OLDEST owned channel (new channels are appended), not
    // the one we just made — so on an account with a backlog of older e2e
    // channels the post would publish to the wrong channel: alice's own home
    // feed shows it (it lists all her channels), but bob is subscribed to the
    // NEW channel and would never see it, however much he refreshes. The picker
    // only renders with >1 owned channel; a clean single-channel account
    // already defaults correctly. waitFor (not isVisible) — it renders a beat
    // after the composer expands on fill.
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

    await expect(alice.getByText(postBody)).toBeVisible({ timeout: 90_000 })

    // -- Bob opens alice's link and watches the channel --
    //
    // Two steps, because there are two decisions. Opening a link is navigation:
    // it resolves the channel from the key the link carries and renders it, and
    // touches no store. Watching is the relation, taken on the page by the same
    // pill every other route there offers.

    await openPinLinkButton(bob).click()

    await expect(
      bob.getByRole('heading', { name: /Open a Pin link/i }),
    ).toBeVisible()
    await bob.getByPlaceholder(/pin:\/\//i).fill(channelURL)
    await bob.getByRole('button', { name: 'Open', exact: true }).click()

    // The channel page, resolved from the link's own key — bob holds no
    // subscription yet, so this is the cold read the key alone buys.
    await expect(
      bob.getByRole('button', { name: 'Watch', exact: true }),
    ).toBeVisible({ timeout: 150_000 })
    await bob.getByRole('button', { name: 'Watch', exact: true }).click()
    await expect(
      bob.getByRole('button', { name: 'Watching', exact: true }),
    ).toBeVisible({ timeout: 90_000 })

    // Back to the feed, which is what the rest of this asserts against.
    await bob.getByRole('button', { name: 'Home', exact: true }).first().click()

    // Bob's feed populates by resolving the channel's pkarr locator off the
    // DHT, then fetching + decrypting the Sia manifest and its item bytes. But
    // the locator is eventually-consistent and there's no live push, so alice's
    // just-published post may not be in the manifest bob first resolves — poll
    // by re-resolving (Refresh) until it propagates and lands.
    await refreshUntilVisible(bob, postBody)
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

    // Open alice's channel from bob's Following list. Scoped to the left
    // sidebar's list — the channel name also appears in feed rows and in the
    // right PinSidebar.
    await followingList(bob)
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
        await drainE2EChannels(alice)
      } catch (e) {
        console.warn('[alice channel cleanup] failed:', e)
      }
    }
    // Drain bob's e2e subscriptions too — he subscribes to each run's
    // channel (which alice then retracts), so without this his sub list
    // grows with dead pointers. Same self-healing loop as alice's channels.
    if (bob) {
      try {
        await drainE2ESubscriptions(bob)
      } catch (e) {
        console.warn('[bob subscription cleanup] failed:', e)
      }
    }
    await aliceContext.close()
    await bobContext.close()
  }
})
