// E2E: the persistent upload queue resume loop, against real Sia + the public
// Mainline DHT (pkarr), driven through the real UI in Chrome.
//
// Simulates "tab closed mid-publish" by HANGING the manifest-commit leg — the
// pkarr relay PUT that publishes a channel's locator to the DHT (atproto's
// putRecord is gone). The runner's Sia byte upload completes and the checkpoint
// persists to IndexedDB, but the locator never publishes, so the post never
// lands. Then we reload (the "reopen") and confirm hydration + the runner
// resume the task from its checkpoint — the post lands without re-uploading,
// and the succeeded task doesn't linger or reappear.
//
// The block must HANG, not abort: a publish that FAILS after the checkpoint is
// persisted as 'failed' (a deliberate-retry state that doesn't auto-resume),
// whereas a hung publish stays parked as a resumable 'pending' snapshot — which
// is exactly what hydration re-runs on reload. The pkarr publish client's
// timeout is generous (Mainline stores take ~5s), so hanging the PUT keeps the
// task parked long enough; we reload promptly once the checkpoint lands.
//
// We arm the block AFTER the channel is created (its initial locator publish is
// a background best-effort pkarr PUT that may hang harmlessly) and just before
// Publish, so it catches the post's manifest commit specifically.

import { expect, type Page, test } from '@playwright/test'
import {
  createChannelButton,
  drainE2EChannels,
  loadAccount,
  signInAccount,
} from '../authHelper'

const SIA_KEY = 'sia-auth-f6b7539e181e45ee'
const QUEUE_DB = 'pin-upload-queue'
// Public pkarr relays the browser publishes/resolves DHT records through. The
// publish is a PUT; resolves are GETs, which we let through.
const PKARR_RELAY = /pkarr\.pubky\.(app|org)/

type QueueSnapshot = {
  total: number
  checkpointed: number
  states: string[]
}

// Read the persisted upload queue out of IndexedDB from the page context.
async function readQueue(page: Page): Promise<QueueSnapshot> {
  return page.evaluate(
    (db) =>
      new Promise<QueueSnapshot>((resolve) => {
        const req = indexedDB.open(db, 1)
        req.onsuccess = () => {
          try {
            const tx = req.result.transaction('tasks', 'readonly')
            const all = tx.objectStore('tasks').getAll()
            all.onsuccess = () => {
              // The persisted record is an Action; a publish's checkpoint lives
              // under ledger.uploadedItemRef (state stays top-level).
              const tasks = all.result as Array<{
                ledger?: { uploadedItemRef?: unknown }
                state?: string
              }>
              resolve({
                total: tasks.length,
                checkpointed: tasks.filter((t) => t.ledger?.uploadedItemRef)
                  .length,
                states: tasks.map((t) => t.state ?? '?'),
              })
            }
            all.onerror = () =>
              resolve({ total: -1, checkpointed: -1, states: [] })
          } catch {
            // store doesn't exist yet (no upload has run) → empty
            resolve({ total: 0, checkpointed: 0, states: [] })
          }
        }
        req.onerror = () => resolve({ total: -1, checkpointed: -1, states: [] })
      }),
    QUEUE_DB,
  )
}

test('an interrupted publish resumes from its checkpoint on reload', async ({
  browser,
}) => {
  const context = await browser.newContext()
  context.on('weberror', (e) => console.log('[alice weberror]', e.error()))

  let alice: Page | undefined
  try {
    alice = await signInAccount(context, loadAccount('alice'))

    // -- Create a channel to publish into --
    await createChannelButton(alice).click()
    const channelName = `e2e test ${Date.now()}`
    await alice.getByPlaceholder(/e\.g\. John Williams/i).fill(channelName)
    await alice.getByRole('button', { name: /Create channel/i }).click()
    // Generous: create now does two serial Sia uploads (manifest + settings
    // snapshot) + a pkarr publish before the confirmation, and Sia uploads churn
    // through QUIC-failing hosts. See cross-account.spec.ts for the rationale.
    await expect(
      alice.getByRole('heading', { name: /Channel created/i }),
    ).toBeVisible({ timeout: 150_000 })
    await alice.getByRole('button', { name: /^Done$/ }).click()

    // Fill the body first — that expands the composer so the voice picker (if
    // any) renders and canSubmit is satisfied.
    const postBody = `Resume me — ${Date.now()}`
    await alice.getByPlaceholder(/What are you thinking about/i).fill(postBody)

    // The composer only renders a "Voice:" picker when the account owns more
    // than one channel; with a single channel (common once the backlog is
    // drained) the default voice is already the one we just created. When
    // present, pick the new channel explicitly so the resumed publish targets a
    // channel that exists. waitFor (not isVisible) — it renders a beat after
    // the composer expands.
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

    // -- Block the manifest commit, then publish --
    // Hang the pkarr locator PUT: the runner uploads the body bytes to Sia
    // (real) and writes the checkpoint, then hangs publishing the locator — the
    // post is stuck mid-publish. Resolves (GETs) pass through so feed reads
    // don't wedge. Must hang, not abort, so the task stays a resumable
    // 'pending' snapshot rather than failing (see the header note).
    await alice.route(PKARR_RELAY, (route) => {
      if (route.request().method() === 'PUT') return // hang the publish
      route.continue()
    })

    await alice.getByRole('button', { name: /^Publish$/ }).click()

    // The checkpoint lands in IndexedDB once the Sia upload completes.
    await expect
      .poll(async () => (await readQueue(alice!)).checkpointed, {
        timeout: 90_000,
        intervals: [1000],
      })
      .toBeGreaterThan(0)

    // The post has NOT landed yet — the manifest write is blocked, so the
    // task is parked at its checkpoint.
    const parked = await readQueue(alice)
    expect(parked.states.every((s) => s !== 'success')).toBe(true)

    // -- Reopen the tab --
    // Reseed the live auth state (now holding myChannels + the auto-sub to
    // alice's own channel) so the resumed task finds its channel. The auth
    // helper's init script seeds no myChannels, so a plain reload would
    // rehydrate them empty — a harness artifact; in production localStorage
    // already holds myChannels on reload, so this restores production-faithful
    // state. (A later-registered init script runs after the helper's, so this
    // full-state seed wins.)
    const liveAuth = await alice.evaluate((k) => localStorage.getItem(k), SIA_KEY)
    await context.addInitScript(
      ({ key, payload }) => {
        try {
          if (window.location.origin === 'http://127.0.0.1:4173' && payload) {
            localStorage.setItem(key, payload)
          }
        } catch {
          // ignore origins that block localStorage
        }
      },
      { key: SIA_KEY, payload: liveAuth },
    )

    await alice.unroute(PKARR_RELAY)
    await alice.reload()

    // Resume: hydration loads the pending checkpointed task, the runner
    // skips re-upload and completes the manifest write — the post lands.
    await expect(alice.getByText(postBody).first()).toBeVisible({
      timeout: 90_000,
    })

    // The succeeded task drains itself from IndexedDB — nothing lingers.
    await expect
      .poll(async () => (await readQueue(alice!)).total, {
        timeout: 30_000,
        intervals: [1000],
      })
      .toBe(0)

    // -- Reopen once more: clean slate (drained queue), no in-flight noise --
    await alice.reload()
    await expect(alice.getByText(postBody).first()).toBeVisible({
      timeout: 90_000,
    })

    // No duplicate post: on the new channel's own page exactly one item row
    // carries the body (the channel page lists only that channel's items, so
    // a double-append would show two). Scope past the feed/sidebar surfaces
    // that also echo the text on home.
    const sidebar = alice.locator('aside').filter({
      has: alice.getByRole('button', { name: 'Home', exact: true }),
    })
    await sidebar
      .locator('ul[aria-label="Your channels"]')
      .getByRole('button', { name: channelName })
      .first()
      .click({ timeout: 30_000 })
    await expect(alice.getByText(postBody).first()).toBeVisible({
      timeout: 30_000,
    })
    expect(await alice.getByText(postBody).count()).toBe(1)

    // The succeeded task did not reappear from persistence.
    expect((await readQueue(alice)).total).toBe(0)
  } finally {
    if (alice) {
      try {
        await drainE2EChannels(alice)
      } catch (e) {
        console.warn('[alice channel cleanup] failed:', e)
      }
    }
    await context.close()
  }
})
