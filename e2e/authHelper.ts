// Per-test authentication helper. Each scenario test creates fresh
// browser contexts and runs this for each account.
//
// Why not Playwright's setup-project + storageState fixtures? The
// @atproto/oauth-client-browser session getter uses an in-memory
// CachedGetter wrapping an IndexedDB store. Restoring just the
// IndexedDB via storageState doesn't restore the cache; the first
// "isStale" check after restore triggers a refresh, the refresh
// reads from IndexedDB and finds nothing matching the in-memory key,
// and the lib throws "The session was deleted by another process".
//
// Auth-per-test is ~5s of overhead per scenario. We'll re-investigate
// shared sessions if/when test count makes that overhead matter.

import { type BrowserContext, expect, type Page } from '@playwright/test'

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
      `Missing env var ${key}. Set it in e2e/.env.test (see e2e/README.md).`,
    )
  }
  return v
}

export function loadAccount(name: 'alice' | 'bob'): Account {
  const prefix = name.toUpperCase()
  return {
    name,
    blueskyHandle: envOrFail(`${prefix}_BLUESKY_HANDLE`),
    blueskyPassword: envOrFail(`${prefix}_BLUESKY_PASSWORD`),
    siaKeyHex: envOrFail(`${prefix}_SIA_KEY_HEX`),
    siaIndexerURL:
      process.env[`${prefix}_SIA_INDEXER_URL`] ?? 'https://sia.storage',
  }
}

// Seeds the Sia AppKey into localStorage + drives the Bluesky OAuth
// flow. On return, the context is signed in for both Sia and Bluesky
// and parked at the empty-state home page.
export async function signInAccount(
  context: BrowserContext,
  account: Account,
): Promise<Page> {
  await context.addInitScript(
    ({ key, payload, pinOrigin }) => {
      // The init script fires on every page load in the context,
      // including bsky.social during the OAuth redirect — that origin
      // blocks localStorage and throws SecurityError on bare access.
      // Only seed on Pin's own origin.
      try {
        if (window.location.origin === pinOrigin) {
          localStorage.setItem(key, payload)
        }
      } catch {
        // Some origins block localStorage entirely; ignore silently.
      }
    },
    {
      key: SIA_LOCALSTORAGE_KEY,
      pinOrigin: 'http://127.0.0.1:4173',
      payload: JSON.stringify({
        state: {
          storedKeyHex: account.siaKeyHex,
          indexerURL: account.siaIndexerURL,
          myChannels: [],
          subscriptions: [],
          atprotoDID: null,
          // Seed the handle even though it's normally null until OAuth
          // resolves — Pin's narrow OAuth scope means getProfile 403s
          // and atprotoHandle would stay null on first sign-in, which
          // CreateChannel rejects. setATProtoIdentity null-coalesces, so
          // a pre-seeded handle survives the OAuth callback's null
          // result. Production has the same "first-sign-in handle is
          // null" gap (flagged as a future thread in CLAUDE.md).
          atprotoHandle: account.blueskyHandle,
          feedSortOrder: 'newest',
          settingsObjectID: null,
        },
        version: 0,
      }),
    },
  )

  const page = await context.newPage()
  await page.goto('/')

  // Sia restore lands us in empty-state home. If the seeded hex didn't
  // validate at the indexer, we'd be on the "Welcome back" screen
  // instead — fail loudly so the user re-bakes the AppKey.
  // Universal "we're at home, Sia is connected" signal — present whether
  // the home is empty, loading, or populated, but NOT on the Welcome
  // back screen. If Sia restore failed, this times out → fail loudly.
  await expect(page.getByRole('button', { name: /Sign Out/i })).toBeVisible({
    timeout: 20_000,
  })

  // Trigger the lazy Bluesky gate via the sidebar "+ Create a channel"
  // button. gotoCreating() checks for atprotoAgent; with none yet, it
  // routes to the BlueskyLoginScreen. (Welcome-screen "Create a channel"
  // only appears for fresh accounts with no subscriptions; the sidebar
  // entry is always present, so it's the safer selector for an account
  // that may have accumulated state from prior test runs.)
  await page
    .getByRole('button', { name: '+ Create a channel' })
    .click()

  await expect(
    page.getByRole('heading', { name: /Sign in with Bluesky/i }),
  ).toBeVisible({ timeout: 10_000 })

  await page
    .getByPlaceholder(/yourname\.bsky\.social/i)
    .fill(account.blueskyHandle)
  await page.getByRole('button', { name: /Continue with Bluesky/i }).click()

  // bsky.social OAuth screens. Selectors are best-effort scrapes of
  // their UI; when they redesign, this breaks loudly — signal we should
  // look at what changed.
  await page.waitForURL(/bsky\.social/, { timeout: 30_000 })
  await page.getByPlaceholder(/password/i).first().fill(account.blueskyPassword)
  await page.getByRole('button', { name: /Next|Sign in/i }).first().click()
  await page
    .getByRole('button', { name: /Accept|Authorize|Continue/i })
    .first()
    .click({ timeout: 30_000 })
  await page.waitForURL(/127\.0\.0\.1:4173/, { timeout: 30_000 })

  // Returned to Pin. We may land on the create-channel form (resumeTo
  // target); back out so callers see a clean home.
  const back = page.getByRole('button', { name: /Back/i }).first()
  if (await back.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await back.click()
  }
  await expect(page.getByRole('button', { name: /Sign Out/i })).toBeVisible({
    timeout: 10_000,
  })

  return page
}

// settings-sync repopulates myChannels + subscriptions from Sia a beat after
// sign-in / navigation (the auth seed and the addInitScript both start them
// at []). Querying the sidebar before that races to a false-empty read — the
// root cause of cleanup silently draining nothing and the test-channel
// backlog growing. Poll localStorage until the combined count stabilizes
// non-zero, capped so a genuinely-empty account still returns promptly.
export async function waitForChannelsLoaded(page: Page): Promise<void> {
  let prev = -1
  for (let t = 0; t < 12; t++) {
    const n = await page.evaluate((key) => {
      const s = JSON.parse(localStorage.getItem(key) || '{}').state
      return (
        (s?.myChannels ?? []).length + (s?.subscriptions ?? []).length
      ) as number
    }, SIA_LOCALSTORAGE_KEY)
    if (n > 0 && n === prev) return
    prev = n
    await page.waitForTimeout(2000)
  }
}
