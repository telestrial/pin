// Playwright "setup" project. Runs once at the start of every `bun run
// test:e2e` invocation; produces fixture storageState files at
// `e2e/.auth/<account>.json` that downstream tests load via
// `browser.newContext({ storageState: ... })`.
//
// Two surfaces, two strategies:
// - Bluesky: full OAuth automation. We drive the bsky.social UI using
//   handle + password from `.env.test`. Brittle to bsky.social UI changes
//   on purpose — when they redesign, this test fails loudly.
// - Sia: shortcut via `storedKeyHex`. The hex value (one-time-captured by
//   manually onboarding once at sia.storage) is set into localStorage
//   before the page loads, and the app's AuthFlow restores the AppKey via
//   `Builder.connected(appKey)`. No sia.storage UI scraping.

import { expect, test as setup } from '@playwright/test'
import { join } from 'node:path'

// localStorage key Pin uses for the persisted Sia auth slice.
// Matches stores/auth.ts: `sia-auth-${APP_KEY.slice(0, 16)}`.
const SIA_LOCALSTORAGE_KEY = 'sia-auth-f6b7539e181e45ee'

type Account = {
  name: 'alice' | 'bob'
  blueskyHandle: string
  blueskyPassword: string
  siaKeyHex: string
  siaIndexerURL: string
}

function envOrFail(key: string): string {
  const v = process.env[key]
  if (!v) {
    throw new Error(
      `Missing env var ${key}. Set it in e2e/.env.test (see e2e/README.md for the one-time bake step).`,
    )
  }
  return v
}

function loadAccount(name: 'alice' | 'bob'): Account {
  const prefix = name.toUpperCase()
  return {
    name,
    blueskyHandle: envOrFail(`${prefix}_BLUESKY_HANDLE`),
    blueskyPassword: envOrFail(`${prefix}_BLUESKY_PASSWORD`),
    siaKeyHex: envOrFail(`${prefix}_SIA_KEY_HEX`),
    siaIndexerURL: process.env[`${prefix}_SIA_INDEXER_URL`] ?? 'https://sia.storage',
  }
}

setup.describe.configure({ mode: 'serial' })

for (const accountName of ['alice', 'bob'] as const) {
  setup(`authenticate ${accountName}`, async ({ browser }) => {
    const account = loadAccount(accountName)
    const context = await browser.newContext()

    // Seed the Sia auth slice into localStorage BEFORE the app boots, so
    // AuthFlow's `Builder.connected(appKey)` restore path fires on first
    // mount and we land in step='connected' for the Sia half.
    await context.addInitScript(
      ({ key, payload }) => {
        localStorage.setItem(key, payload)
      },
      {
        key: SIA_LOCALSTORAGE_KEY,
        payload: JSON.stringify({
          state: {
            storedKeyHex: account.siaKeyHex,
            indexerURL: account.siaIndexerURL,
            myChannels: [],
            subscriptions: [],
            atprotoDID: null,
            atprotoHandle: null,
            feedSortOrder: 'newest',
            settingsObjectID: null,
          },
          version: 0,
        }),
      },
    )

    const page = await context.newPage()
    await page.goto('/')

    // The seeded Sia key restores synchronously; once that's done the
    // AuthFlow effect decides between welcome (returning user) and Sia
    // approval. Either way, the navbar/home should appear after the
    // OAuth round-trip — we trigger it explicitly via "Get started" so
    // the AuthFlow knows to add ATProto on top of the restored Sia.

    // If the seeded Sia key was valid, the app jumps straight to home.
    // If not (e.g. hex doesn't match a registered AppKey), we'd land on
    // welcome with "Welcome back"; in that case, fail loudly so the user
    // knows to re-bake the Sia key.
    await page.waitForLoadState('networkidle')

    const onConnected = await page.getByRole('button', { name: /Create a channel/i })
      .or(page.getByText(/No items yet from your subscriptions/i))
      .or(page.getByText(/Pin/i))
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false)

    if (!onConnected) {
      throw new Error(
        `Sia restore failed for ${account.name} — the seeded storedKeyHex didn't validate at the indexer. Re-bake by manually onboarding the account at sia.storage and copying localStorage["${SIA_LOCALSTORAGE_KEY}"].state.storedKeyHex into .env.test.`,
      )
    }

    // Sia is connected. Now drive the Bluesky OAuth flow on top.
    // From the home/welcome state, "+ Create a channel" forces a Bluesky
    // gate; that's the cheapest path to triggering OAuth without a
    // dedicated onboarding step.
    //
    // If the user is already-authed Bluesky from a prior bake, the click
    // would proceed directly into channel creation; we detect that by
    // looking for the form header.
    const createButton = page.getByRole('button', { name: /Create a channel/i })
    if (await createButton.isVisible().catch(() => false)) {
      await createButton.click()

      // If we land on a Bluesky onboarding screen, run the OAuth flow.
      const blueskyHandleInput = page.getByLabel(/handle/i).or(
        page.getByPlaceholder(/handle\.bsky\.social/i),
      )
      const onCreateForm = await page
        .getByRole('heading', { name: /Create a channel/i })
        .isVisible({ timeout: 2_000 })
        .catch(() => false)

      if (!onCreateForm && await blueskyHandleInput.isVisible({ timeout: 5_000 })) {
        await blueskyHandleInput.fill(account.blueskyHandle)
        await page.getByRole('button', { name: /Continue|Sign in|Get started/i }).click()

        // We redirect to bsky.social. Wait for the password field there.
        await page.waitForURL(/bsky\.social/, { timeout: 30_000 })
        await page.getByLabel(/password/i).fill(account.blueskyPassword)
        // bsky's "Sign in" then potentially "Accept" / "Authorize".
        await page.getByRole('button', { name: /Sign in/i }).click()

        // Scope-approval page. Click Accept / Authorize.
        const approve = page.getByRole('button', {
          name: /Accept|Authorize|Continue/i,
        })
        await approve.click({ timeout: 30_000 })

        // Redirect back to Pin.
        await page.waitForURL(/127\.0\.0\.1:4173/, { timeout: 30_000 })
      }

      // Whether we just authed or were already authed, we should be on the
      // create-channel form now (or already-home if click was idempotent).
      // No more auth work needed — back out without creating a channel.
      const cancel = page.getByRole('button', { name: /Cancel|Back/i })
      if (await cancel.isVisible().catch(() => false)) {
        await cancel.click()
      }
    }

    // Final state check: the post-auth shell should be visible. Assertion
    // ensures we don't save a broken storageState.
    await expect(
      page.getByText(/Create a channel|Subscribe|No items yet/i).first(),
    ).toBeVisible({ timeout: 10_000 })

    // Persist cookies + localStorage + IndexedDB (where Bluesky OAuth tokens
    // live, via @atproto/oauth-client-browser).
    const fixturePath = join(
      import.meta.dirname,
      '.auth',
      `${account.name}.json`,
    )
    await context.storageState({ path: fixturePath, indexedDB: true })
    await context.close()
  })
}
