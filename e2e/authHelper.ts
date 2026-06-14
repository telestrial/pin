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

// Shared, bounded retract of this suite's "e2e test" channels. A test's
// in-finally cleanup MUST NOT be able to exceed the test's own time budget —
// that's what let the backlog grow (each run's cleanup got cut off at the
// 10-min ceiling, often masking the body's real result). So this is guarded
// two ways: a hard iteration cap AND a wall-clock budget checked before every
// pass, so a slow/flaky retract can never compound past `budgetMs`. Whatever
// doesn't fit clears incrementally on later runs, or in bulk via
// drain-e2e-channels (which passes a large max + budget). Per-pass failures
// recover to home and continue rather than aborting the whole drain. Returns
// the number drained, for the maintenance task's logging.
//
// Always lands on home + waits for settings-sync first, so a test that failed
// mid-flow (leaving the page anywhere) still finds the channel list.
export async function drainE2EChannels(
  page: Page,
  { max = 8, budgetMs = 150_000 }: { max?: number; budgetMs?: number } = {},
): Promise<number> {
  // Bounded nav: a Sia boot churning through QUIC-failing hosts (a normal
  // characteristic of the network, not necessarily a bad run) can stall the
  // load event long enough that an un-timed goto would hang cleanup for the
  // whole test budget (the 10-min timeouts we saw land in the finally block).
  // Best-effort — proceed even if it times out; the sidebar query below just
  // finds nothing to drain.
  await page.goto('/', { timeout: 60_000 }).catch(() => {})
  await waitForChannelsLoaded(page)
  const sidebar = page.locator('aside').filter({
    has: page.getByRole('button', { name: 'Home', exact: true }),
  })
  // Owners auto-subscribe to their own channels, so the name also appears in
  // "Subscribed channels"; narrow to the "Your channels" UL so we retract
  // (owned) rather than unsubscribe.
  const yourChannels = sidebar.locator('ul[aria-label="Your channels"]')

  const start = Date.now()
  let drained = 0
  for (let i = 0; i < max; i++) {
    if (Date.now() - start > budgetMs) break // wall-clock guard — never blow the budget
    const candidates = yourChannels.getByRole('button', { name: /e2e test/i })
    if ((await candidates.count()) === 0) break
    try {
      await candidates.first().click({ timeout: 30_000 })
      // window.prompt() is a native dialog in Playwright — accept with the
      // required typed DELETE before the click that triggers it.
      page.once('dialog', (d) => d.accept('DELETE'))
      const unpin = page.getByRole('button', {
        name: 'Unpin this channel',
        exact: true,
      })
      await unpin.click({ timeout: 30_000 })
      // NB: waitFor + catch, NOT expect(). A failed expect() in @playwright/test
      // taints the test result even when the throw is caught — so cleanup, where
      // a slow/failed retract must stay non-fatal, must never assert.
      await unpin.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
      if (!(await unpin.isVisible().catch(() => false))) drained++
    } catch (e) {
      console.warn(`[drainE2EChannels] pass ${i} failed, recovering:`, e)
      await page
        .getByRole('button', { name: 'Home', exact: true })
        .first()
        .click({ timeout: 30_000 })
        .catch(() => {})
    }
  }
  return drained
}

// Sibling of drainE2EChannels for subscribed channels — a subscriber (bob)
// accumulates dead subscriptions to channels that get retracted. Same bounded
// + budgeted + recover-and-continue shape.
export async function drainE2ESubscriptions(
  page: Page,
  { max = 8, budgetMs = 150_000 }: { max?: number; budgetMs?: number } = {},
): Promise<number> {
  // Bounded nav: a Sia boot churning through QUIC-failing hosts (a normal
  // characteristic of the network, not necessarily a bad run) can stall the
  // load event long enough that an un-timed goto would hang cleanup for the
  // whole test budget (the 10-min timeouts we saw land in the finally block).
  // Best-effort — proceed even if it times out; the sidebar query below just
  // finds nothing to drain.
  await page.goto('/', { timeout: 60_000 }).catch(() => {})
  await waitForChannelsLoaded(page)
  const sidebar = page.locator('aside').filter({
    has: page.getByRole('button', { name: 'Home', exact: true }),
  })
  const subscribed = sidebar.locator('ul[aria-label="Subscribed channels"]')

  const start = Date.now()
  let drained = 0
  for (let i = 0; i < max; i++) {
    if (Date.now() - start > budgetMs) break
    const candidates = subscribed.getByRole('button', { name: /e2e test/i })
    if ((await candidates.count()) === 0) break
    try {
      await candidates.first().click({ timeout: 30_000 })
      page.once('dialog', (d) => d.accept())
      const unsub = page.getByRole('button', { name: 'Unsubscribe' })
      await unsub.click({ timeout: 30_000 })
      // waitFor + catch, NOT expect() — see drainE2EChannels: a caught expect()
      // still fails the test, so cleanup must not assert.
      await unsub.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {})
      if (!(await unsub.isVisible().catch(() => false))) drained++
    } catch (e) {
      console.warn(`[drainE2ESubscriptions] pass ${i} failed, recovering:`, e)
      await page
        .getByRole('button', { name: 'Home', exact: true })
        .first()
        .click({ timeout: 30_000 })
        .catch(() => {})
    }
  }
  return drained
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
