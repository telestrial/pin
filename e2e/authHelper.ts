// Per-test authentication helper. Each scenario test creates fresh
// browser contexts and runs this for each account.
//
// Identity is self-sovereign now: a did:dht derived from the Sia recovery
// phrase — no Bluesky/atproto session, no OAuth. So "signing in" is just
// restoring the Sia AppKey. We seed it (bake-once-then-replay; see the
// one-time capture in e2e/README.md) into localStorage and let the app's
// normal boot restore the session from it — no UI flow to drive.
//
// We also seed a chosen @-name (profile.username), which makes the context
// behave as a *returning* identity. The app's genesis naming gate only fires
// for a connected identity with no username, so seeding one keeps us landing
// straight on Home instead of the NamingScreen. Same replay spirit as seeding
// the AppKey — the naming beat isn't what these scenarios exercise.

import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
} from '@playwright/test'

const SIA_LOCALSTORAGE_KEY = 'sia-auth-f6b7539e181e45ee'

// The left nav sidebar, scoped by its unique Home button. Several <aside>s and
// surfaces carry overlapping accessible names — the sidebar's add-actions are
// `+` icon buttons labeled "Create a channel" / "Subscribe to a channel", and
// the EMPTY-home welcome renders CTA buttons with those exact same names — so
// create/subscribe clicks must be scoped here to avoid a strict-mode match on
// two elements. Mirrors the scoping the drain helpers already use.
export function leftSidebar(page: Page): Locator {
  return page.locator('aside').filter({
    has: page.getByRole('button', { name: 'Home', exact: true }),
  })
}

// The sidebar's "+" create-a-channel action (aria-label, not the old
// "+ Create a channel" text CTA that the pre-redesign sidebar had).
export function createChannelButton(page: Page): Locator {
  return leftSidebar(page).getByRole('button', {
    name: 'Create a channel',
    exact: true,
  })
}

// The sidebar's "+" subscribe action. Distinct from the subscribe FORM's submit
// button (name "Subscribe", exact) — this is "Subscribe to a channel".
export function subscribeButton(page: Page): Locator {
  return leftSidebar(page).getByRole('button', {
    name: 'Subscribe to a channel',
    exact: true,
  })
}

type Account = {
  name: 'alice' | 'bob'
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
    siaKeyHex: envOrFail(`${prefix}_SIA_KEY_HEX`),
    siaIndexerURL:
      process.env[`${prefix}_SIA_INDEXER_URL`] ?? 'https://sia.storage',
  }
}

// Seeds the Sia AppKey (+ a chosen @-name) into localStorage and lets the app
// restore the session on load. On return, the context is connected and parked
// on the home feed.
export async function signInAccount(
  context: BrowserContext,
  account: Account,
): Promise<Page> {
  await context.addInitScript(
    ({ key, payload, pinOrigin }) => {
      // The init script fires on every page load in the context. Seed only on
      // Pin's own origin (belt-and-suspenders — the app is single-origin now,
      // but other origins can block localStorage and throw).
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
          // Seed a chosen @-name so we replay as a returning did:dht identity:
          // the genesis naming gate (connected + settingsLoaded + no username)
          // stays shut and we land straight on Home. The Sia snapshot load may
          // replace this with the account's own persisted profile — which also
          // carries a username once the account has been used — so the gate
          // stays shut either way.
          profile: {
            $type: 'dev.sia.pin.profile',
            username: account.name,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        version: 0,
      }),
    },
  )

  const page = await context.newPage()
  await page.goto('/')

  // Universal "connected + on Home" signal: the left sidebar's Home button.
  // Present on the connected home surface (empty or populated), absent on the
  // auth/naming screens — it replaces the removed "Sign Out" button. Sia
  // restore from the seeded AppKey lands us here; a restore failure (bad or
  // revoked hex) leaves us on the Welcome screen and this times out — fail
  // loudly so the AppKey gets re-baked.
  await expect(
    page.getByRole('button', { name: 'Home', exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 })

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
