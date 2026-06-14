// E2E: the persistent upload queue resume loop, against real Sia + real
// bsky.social, driven through the real UI in Chrome.
//
// Simulates "tab closed mid-publish" by blocking the manifest-write XRPC
// call (com.atproto.repo.putRecord) so the runner's Sia upload completes and
// the checkpoint persists to IndexedDB, but the post never lands. Then we
// reload (the "reopen") and confirm hydration + the runner resume the task
// from its checkpoint — the post lands without re-uploading, and the
// succeeded task doesn't linger or reappear.
//
// Channel creation uses applyWrites (not putRecord), so blocking putRecord
// only catches the publish-append, not the channel setup.

import { expect, type Page, test } from '@playwright/test'
import { loadAccount, signInAccount } from '../authHelper'

const SIA_KEY = 'sia-auth-f6b7539e181e45ee'
const QUEUE_DB = 'pin-upload-queue'
const PUT_RECORD = '**/xrpc/com.atproto.repo.putRecord'

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
              const tasks = all.result as Array<{
                uploadedItemRef?: unknown
                state?: string
              }>
              resolve({
                total: tasks.length,
                checkpointed: tasks.filter((t) => t.uploadedItemRef).length,
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
    await alice.getByRole('button', { name: '+ Create a channel' }).click()
    const channelName = `e2e test ${Date.now()}`
    await alice.getByPlaceholder(/e\.g\. John Williams/i).fill(channelName)
    await alice.getByRole('button', { name: /Create channel/i }).click()
    await expect(
      alice.getByRole('heading', { name: /Channel created/i }),
    ).toBeVisible({ timeout: 60_000 })
    await alice.getByRole('button', { name: /^Done$/ }).click()

    // The composer defaults its voice to one of the account's channels,
    // which (on an account with a backlog of older "e2e test" channels) may
    // be a stale/retracted one. Explicitly publish AS the channel we just
    // created so the resume targets a record that exists.
    await alice.getByRole('button', { name: /^Voice:/ }).click()
    await alice
      .getByRole('menuitem', { name: channelName })
      .click({ timeout: 10_000 })

    // -- Block the manifest write, then publish --
    // The runner uploads the body bytes to Sia (real), writes the checkpoint,
    // then hangs on the blocked putRecord — the post is stuck mid-publish.
    await alice.route(PUT_RECORD, () => {
      // never continue/fulfill/abort → the request hangs, as if the tab
      // were closed before the manifest write returned.
    })

    const postBody = `Resume me — ${Date.now()}`
    await alice.getByPlaceholder(/What are you thinking about/i).fill(postBody)
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
    // helper's init script reseeds an EMPTY myChannels on every load — a
    // harness artifact; in production localStorage already holds myChannels
    // on reload, so this restores production-faithful state.
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

    await alice.unroute(PUT_RECORD)
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
        await cleanupE2EChannels(alice)
      } catch (e) {
        console.warn('[alice channel cleanup] failed:', e)
      }
    }
    await context.close()
  }
})

// Retract every "e2e test" channel so the account never accumulates. Same
// self-healing drain-loop as the cross-account spec.
async function cleanupE2EChannels(page: Page) {
  const sidebar = page.locator('aside').filter({
    has: page.getByRole('button', { name: 'Home', exact: true }),
  })
  const yourChannels = sidebar.locator('ul[aria-label="Your channels"]')

  for (let i = 0; i < 20; i++) {
    const candidates = yourChannels.getByRole('button', { name: /e2e test/i })
    if ((await candidates.count()) === 0) break
    await candidates.first().click({ timeout: 30_000 })
    page.once('dialog', (dialog) => dialog.accept('DELETE'))
    const unpinChannel = page.getByRole('button', {
      name: 'Unpin this channel',
      exact: true,
    })
    await unpinChannel.click()
    await expect(unpinChannel).toBeHidden({ timeout: 120_000 })
  }
}
