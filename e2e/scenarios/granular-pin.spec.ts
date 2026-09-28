// E2E: granular pinning — pin the post vs pin the file — cross-account on
// real Sia + the public Mainline DHT (pkarr).
//
// alice publishes a post WITH a file attachment (the composer has no plain
// file input, so we synthesize a drag-drop with a DataTransfer carrying a
// real File). bob subscribes and exercises the two custody relationships the
// 06-12 slice introduced, which only a real-network cross-account run proves:
//
//   1. Pinning ONE file mirrors just that attachment into bob's Library as a
//      standalone item (channel.channelID === 'library') — independent of any
//      whole-post pin.
//   2. Non-aliasing: pinning the WHOLE post does NOT mark the file pinned. A
//      whole-post pin stores attachment URLs inside item.attachments, never as
//      a pin's itemURL, so isPinned(attachment.url) stays false — the file pin
//      button still reads "Pin this file…", not "Remove…".
//   3. Unpinning the file is independent of the post pin (and vice versa).
//
// The author-side single-file retract (removeAttachmentFromItem, reference-safe
// eager byte-free) is covered at the integration tier (granularPin.int.test.ts)
// and intentionally not re-proven here — the e2e tier stays small and focuses
// on the cross-account custody that the fakes can't reconcile on their own.

import { expect, type Page, test } from '@playwright/test'
import {
  createChannelButton,
  drainE2EChannels,
  drainE2ESubscriptions,
  loadAccount,
  refreshUntilVisible,
  signInAccount,
  openPinLinkButton,
  waitForChannelPublished,
} from '../authHelper'

const PINS_KEY = 'sia-pins-f6b7539e181e45ee'

// Read pin custody out of the persisted Zustand store. Library (standalone
// file) pins carry channel.channelID === 'library'; everything else is a
// channel-bound (whole-post) pin.
async function readPins(page: Page): Promise<{ total: number; library: number }> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    const pinned: Array<{ channel?: { channelID?: string } }> = raw
      ? (JSON.parse(raw).state?.pinned ?? [])
      : []
    return {
      total: pinned.length,
      library: pinned.filter((p) => p?.channel?.channelID === 'library').length,
    }
  }, PINS_KEY)
}

test('pin the file vs pin the post: independent cross-account custody', async ({
  browser,
}) => {
  // Re-enabled 2026-09-25, with cross-account.spec.ts and for the same reason:
  // the relays it could not resolve through were the public ones, whose 300s cache
  // floor a publisher cannot argue down. They are ours now, on a 1-5s TTL window.
  const aliceContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const bobContext = await browser.newContext()

  for (const [label, ctx] of [
    ['alice', aliceContext],
    ['bob', bobContext],
  ] as const) {
    ctx.on('weberror', (e) => console.log(`[${label} weberror]`, e.error()))
  }

  let alice: Page | undefined
  let bob: Page | undefined
  try {
    alice = await signInAccount(aliceContext, loadAccount('alice'))
    bob = await signInAccount(bobContext, loadAccount('bob'))

    // -- Alice creates a channel and grabs its subscribe URL --
    await createChannelButton(alice).click()
    const channelName = `e2e test ${Date.now()}`
    await alice.getByPlaceholder(/e\.g\. John Williams/i).fill(channelName)
    await alice.getByRole('button', { name: /Create channel/i }).click()
    // The create puts alice back where she was and shows the channel in the sidebar as
    // it is set up. `myChannels` gaining it IS the commit — see waitForChannelPublished.
    await waitForChannelPublished(alice, channelName)
    // The link lives on the page of a channel you own, so open it from the sidebar.
    await alice
      .getByRole('list', { name: 'Your channels' })
      .getByRole('button', { name: channelName })
      .click()
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
    await alice.getByRole('button', { name: 'Home', exact: true }).first().click()

    // -- Alice publishes a post WITH a file attachment --
    // Fill the body first — that expands the composer (so the voice picker,
    // if any, renders) and satisfies canSubmit.
    const postBody = `Granular pin — ${Date.now()}`
    await alice.getByPlaceholder(/What are you thinking about/i).fill(postBody)

    // Best-effort voice selection: the composer only renders a "Voice:" picker
    // when the account owns MORE than one channel; with a single channel (the
    // one just created — the common case once the backlog is drained) the
    // default voice is already that channel, so the picker is absent. Bounded
    // so a missing picker can't hang the click for the whole test budget; when
    // present (backlog of channels), explicitly pick the new one so the post
    // lands on the channel bob subscribes to.
    const voicePicker = alice.getByRole('button', { name: /^Voice:/ })
    // waitFor, not isVisible() — isVisible is an immediate check, and the
    // picker renders a beat after fill() expands the composer; an immediate
    // read would miss it and let a multi-channel account publish to the wrong
    // (default) voice.
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

    // The composer attaches files only via drag-drop (no <input type=file>),
    // so synthesize a drop carrying a real File. handleDrop reads
    // e.dataTransfer.files and creates a chip; the bytes upload at Publish.
    const fileName = 'granular-pin-fixture.bin'
    const fileBytes = Array.from({ length: 512 }, (_, i) => i % 256)
    const dataTransfer = await alice.evaluateHandle(
      ({ data, name, type }) => {
        const dt = new DataTransfer()
        dt.items.add(new File([new Uint8Array(data)], name, { type }))
        return dt
      },
      { data: fileBytes, name: fileName, type: 'application/octet-stream' },
    )
    await alice
      .locator('form[data-compose-area="true"]')
      .dispatchEvent('drop', { dataTransfer })

    // The attachment chip (file card with the filename) confirms the drop took.
    await expect(alice.getByText(fileName).first()).toBeVisible({
      timeout: 10_000,
    })
    await alice.getByRole('button', { name: /^Publish$/ }).click()

    // The post lands once the runner uploads body + attachment to Sia and
    // writes the manifest.
    await expect(alice.getByText(postBody)).toBeVisible({ timeout: 90_000 })

    // -- Bob opens alice's link, watches, and sees the post + its attachment --
    // Opening is navigation and watching is the relation; see cross-account.spec.ts
    // for why those are two steps.
    await openPinLinkButton(bob).click()
    await bob.getByPlaceholder(/pin:\/\//i).fill(channelURL)
    await bob.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(
      bob.getByRole('button', { name: 'Watch', exact: true }),
    ).toBeVisible({ timeout: 150_000 })
    await bob.getByRole('button', { name: 'Watch', exact: true }).click()
    await expect(
      bob.getByRole('button', { name: 'Watching', exact: true }),
    ).toBeVisible({ timeout: 90_000 })
    await bob.getByRole('button', { name: 'Home', exact: true }).first().click()
    // Read-on-refresh + eventually-consistent DHT: re-resolve until alice's post
    // propagates into bob's feed (see refreshUntilVisible).
    await refreshUntilVisible(bob, postBody)
    // Scope every pin assertion below to THIS run's row. A feed row is an <li>,
    // and bob's feed carries whatever he still watches — a leftover channel from
    // an earlier run publishes the same fixture under the same filename, so a bare
    // getByTitle resolves to two elements and strict mode fails. `.first()` would
    // silence that while quietly asserting against somebody else's post; scoping
    // makes the assertions about the post under test and independent of whatever
    // cleanup did or did not manage.
    const row = bob.locator('li').filter({ hasText: postBody })
    // The attachment tile renders inline in the same feed row.
    await expect(row.getByText(fileName).first()).toBeVisible({
      timeout: 90_000,
    })

    // Fresh slate: nothing pinned yet.
    expect(await readPins(bob)).toEqual({ total: 0, library: 0 })

    // -- (2) Non-aliasing: pin the WHOLE post, file stays unpinned --
    // Post pin title is "Pin to your storage (…)"; file pin is "Pin this file
    // to your library (…)" — distinct, no collision.
    await row.getByTitle(/Pin to your storage/).first().click()
    await expect
      .poll(async () => (await readPins(bob!)).total, { timeout: 90_000 })
      .toBe(1)
    // The whole-post pin is channel-bound, not a library pin…
    expect((await readPins(bob)).library).toBe(0)
    // …and crucially it did NOT mark the file pinned: the file button still
    // offers to pin (would read "Remove…" if the post pin had aliased it).
    await expect(
      row.getByTitle(/Pin this file to your library/),
    ).toBeVisible()
    await expect(
      row.getByTitle(/Remove this file from your library/),
    ).toHaveCount(0)

    // -- (1) Pin just the FILE → standalone Library item --
    await row.getByTitle(/Pin this file to your library/).first().click()
    await expect
      .poll(async () => await readPins(bob!), { timeout: 90_000 })
      .toEqual({ total: 2, library: 1 })
    // Button flips to the release affordance.
    await expect(
      row.getByTitle(/Remove this file from your library/),
    ).toBeVisible({ timeout: 30_000 })

    // -- (3) Unpin the FILE → post pin survives --
    await row.getByTitle(/Remove this file from your library/).first().click()
    await expect
      .poll(async () => await readPins(bob!), { timeout: 90_000 })
      .toEqual({ total: 1, library: 0 })
    // The file is pinnable again; the whole-post pin is untouched.
    await expect(
      row.getByTitle(/Pin this file to your library/),
    ).toBeVisible({ timeout: 30_000 })
    await expect(row.getByTitle(/Unpin from your storage/)).toBeVisible()

    // Release bob's whole-post pin too, so he leaves no mirrored bytes behind.
    await row.getByTitle(/Unpin from your storage/).first().click()
    await expect
      .poll(async () => (await readPins(bob!)).total, { timeout: 90_000 })
      .toBe(0)
  } finally {
    if (alice) {
      try {
        await drainE2EChannels(alice)
      } catch (e) {
        console.warn('[alice channel cleanup] failed:', e)
      }
    }
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
