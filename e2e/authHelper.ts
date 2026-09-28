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
// `+` icon buttons labeled "Create a channel" / "Open a Pin link", and the
// EMPTY-home welcome renders CTA buttons with those exact same names — so those
// clicks must be scoped here to avoid a strict-mode match on two elements.
// Mirrors the scoping the drain helpers already use.
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

// The sidebar's "+" open-a-link action, under the Following section.
//
// This was "Subscribe to a channel" and the form behind it subscribed on submit.
// Pasting a link is NAVIGATION now: it opens the channel and the relation is a
// separate decision made on the page, by the same Watch pill every other route
// to that page offers. So a spec that wants bob subscribed opens the link and
// then presses Watch — two steps, because there are two decisions.
export function openPinLinkButton(page: Page): Locator {
  return leftSidebar(page).getByRole('button', {
    name: 'Open a Pin link',
    exact: true,
  })
}

// The sidebar list of everything reaching you — follows AND watches, since a
// subscription is the mechanism under both. Titled for the superset, which is
// why it is no longer "Subscribed channels".
export function followingList(page: Page): Locator {
  return leftSidebar(page).locator(
    'ul[aria-label="Channels you follow or watch"]',
  )
}

// Surface where a create/publish stalls. Channel create/publish does real
// network I/O inline — a Sia manifest upload AND a pkarr publish to the Mainline
// DHT — so a "hang" is one of those legs stalling, not a selector problem. This
// makes it visible in the test output:
//   - Console errors/warnings: a flood of QUIC / NETWORK_IDLE_TIMEOUT lines is
//     the Sia upload churning through hosts (Sia's QUIC traffic is not `fetch`,
//     so it only shows via the SDK's own console logging, not the request hooks).
//   - pkarr relay HTTP (pubky/pkarr): a "→" PUT with no matching "←" response is
//     a stuck DHT publish — the other likely hang.
// Opt-in (E2E_DEBUG=1) — it's noisy (the QUIC churn alone floods the log), so a
// normal run stays quiet; flip it on to localize a hang.
export function attachDiagnostics(page: Page, label: string): void {
  if (!process.env.E2E_DEBUG) return
  page.on('console', (m) => {
    const t = m.type()
    if (t === 'error' || t === 'warning') {
      console.log(`[${label} ${t}] ${m.text()}`)
    }
  })
  const isPkarr = (u: string) => /pubky|pkarr/i.test(u)
  page.on('request', (r) => {
    if (isPkarr(r.url())) console.log(`[${label} pkarr →] ${r.method()} ${r.url()}`)
  })
  page.on('response', (r) => {
    if (isPkarr(r.url())) console.log(`[${label} pkarr ←] ${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', (r) => {
    if (isPkarr(r.url()))
      console.log(`[${label} pkarr ✗] ${r.url()} — ${r.failure()?.errorText}`)
  })
}

// Poll the home feed by clicking Refresh until `text` shows. The subscriber
// feed is read-on-refresh (no live push since JetStream left with atproto): a
// just-published post appears only once its channel locator has propagated
// across the Mainline DHT AND the reader re-resolves. So a single wait can't
// work — we re-resolve on a loop until it lands (harmless when propagation was
// already fast; the first check just passes). The Refresh button is disabled +
// its label hidden while a resolve is in flight, so `.click()` naturally waits
// for the prior resolve to finish before firing again.
export async function refreshUntilVisible(
  page: Page,
  text: string,
  { timeout = 150_000 }: { timeout?: number } = {},
): Promise<void> {
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
  await expect(async () => {
    await refresh.click()
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 10_000 })
  }).toPass({ timeout, intervals: [1_000, 2_000, 3_000] })
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
  attachDiagnostics(page, account.name)
  await page.goto('/')

  // Universal "connected + on Home" signal: the left sidebar's Home button.
  // Present on the connected home surface (empty or populated), absent on the
  // auth/naming screens — it replaces the removed "Sign Out" button.
  //
  // Sized for a real Sia read, not a UI beat. Sign-in no longer lands on Home
  // directly: the doc restore stands between them, and it is a DHT resolve plus
  // a Sia download of the settings snapshot, held behind "Restoring your
  // channels from Sia…" until it settles. A host that will not answer costs the
  // SDK's full 60s read timeout before the next one is tried, so 30s here was a
  // window that happened to fit and then stopped fitting.
  //
  // Two failures still land on this line and they look identical from here: a
  // bad or revoked AppKey hex leaves us on Welcome, and an unreadable snapshot
  // holds us on the restore screen. The error-context snapshot names which.
  await expect(
    page.getByRole('button', { name: 'Home', exact: true }).first(),
  ).toBeVisible({ timeout: 150_000 })

  return page
}

// The signal that a channel is LIVE — manifest on Sia, pkarr pointer published.
//
// Creating a channel is a journaled action: K is minted at enqueue, the form puts you
// back where you were, and the sidebar shows the channel as it is set up. The
// settings entry is written only once `createAndPublishChannel` returns, deliberately
// — an entry in settings is one the identity loop advertises, and advertising a
// channel whose locator resolves to nothing sends every reader to a dead end.
//
// So `myChannels` gaining the name IS the commit having landed, and it is what a spec
// has to wait on before handing the link to anybody or expecting the channel to be
// selectable as a voice.
export async function waitForChannelPublished(
  page: Page,
  channelName: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ key, name }) => {
            const s = JSON.parse(localStorage.getItem(key) || '{}').state
            const mine = (s?.myChannels ?? []) as Array<{ name?: string }>
            return mine.some((c) => c.name === name)
          },
          { key: SIA_LOCALSTORAGE_KEY, name: channelName },
        ),
      { timeout: 180_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(true)
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

  // React paints the sidebar a beat after the persisted store hydrates, and
  // `.count()` does not auto-wait — so counting straight after
  // waitForChannelsLoaded can read zero and break the loop before it starts,
  // which is a cleanup that reports success having drained nothing. Bounded and
  // swallowed, because a genuinely empty list must still return promptly.
  await yourChannels.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})

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
  const subscribed = followingList(page)

  const start = Date.now()
  let drained = 0
  for (let i = 0; i < max; i++) {
    if (Date.now() - start > budgetMs) break
    const candidates = subscribed.getByRole('button', { name: /e2e test/i })
    if ((await candidates.count()) === 0) break
    try {
      await candidates.first().click({ timeout: 30_000 })
      // The relation pill, which replaced the "Unsubscribe" button. It carries
      // the state rather than the action, so the one to click is whichever of
      // the two ON labels is showing — and dropping the relation now takes no
      // confirm, so there is no dialog to accept.
      const drop = page.getByRole('button', { name: /^(Watching|Following)$/ })
      await drop.click({ timeout: 30_000 })
      // Confirm by the OFF label APPEARING, not by the ON one going away: the
      // pill persists across the toggle and only its label changes, so waiting
      // for it to vanish would also be satisfied by it never having rendered.
      // waitFor + catch, NOT expect() — see drainE2EChannels: a caught expect()
      // still fails the test, so cleanup must not assert.
      const dropped = page.getByRole('button', { name: /^(Watch|Follow)$/ })
      await dropped
        .waitFor({ state: 'visible', timeout: 45_000 })
        .catch(() => {})
      if (await dropped.isVisible().catch(() => false)) drained++
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
