// E2E: the persistent upload queue resume loop, against real Sia and the real
// Mainline DHT, driven through the real UI in Chrome.
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

import {
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test'
import {
  createChannelButton,
  drainE2EChannels,
  loadAccount,
  signInAccount,
  waitForChannelPublished,
} from '../authHelper'

const SIA_KEY = 'sia-auth-f6b7539e181e45ee'
const QUEUE_DB = 'pin-upload-queue'
// The pkarr relays the browser publishes/resolves DHT records through. The publish
// is a PUT; resolves are GETs, which we let through.
//
// Both presets are matched because this has to hang whichever relay is in force, and
// a pattern that misses it does not fail the route — the publish simply succeeds and
// the interruption this spec is built on never happens. The app's default is the local
// relay; the public pair is here so a run pinned to VITE_RELAY_PRESET=public still
// blocks the right host.
const PKARR_RELAY = /pkarr\.pubky\.(app|org)|127\.0\.0\.1:6881/

type QueueSnapshot = {
  total: number
  checkpointed: number
  states: string[]
  // Kind alongside state so a leftover task identifies ITSELF. The drain
  // assertion below used to compare a bare count, which reports "expected 0,
  // received 1" and names neither what lingered nor why — and several kinds
  // now share this queue (publish, channel create, delete-objects), only some
  // of which are meant to drain.
  kinds: string[]
  // Identity, so a leftover can be told from a REPLACEMENT: the same id still
  // present means the task never dropped itself, a different one means
  // something enqueued a second publish. A count cannot distinguish those, and
  // they are different bugs.
  ids: string[]
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
                kind?: string
                id?: string
              }>
              resolve({
                total: tasks.length,
                checkpointed: tasks.filter((t) => t.ledger?.uploadedItemRef)
                  .length,
                states: tasks.map((t) => t.state ?? '?'),
                kinds: tasks.map((t) => t.kind ?? '?'),
                ids: tasks.map((t) => t.id ?? '?'),
              })
            }
            all.onerror = () =>
              resolve({ total: -1, checkpointed: -1, states: [], kinds: [], ids: [] })
          } catch {
            // store doesn't exist yet (no upload has run) → empty
            resolve({ total: 0, checkpointed: 0, states: [], kinds: [], ids: [] })
          }
        }
        req.onerror = () => resolve({ total: -1, checkpointed: -1, states: [], kinds: [], ids: [] })
      }),
    QUEUE_DB,
  )
}

// Re-register the auth seed from the page's CURRENT state, and answer with it.
//
// signInAccount's init script runs on every page load and seeds a payload with no
// myChannels, so any reload rehydrates a channel-less account unless something puts
// the live state back — a harness artifact; in production localStorage already holds
// myChannels. Init scripts accumulate and the last one wins, so re-registering before
// each reload is what keeps the app's own state across one. Every reload in this spec
// needs it: the first is covered by the resumed task re-adding the channel, but the
// second has no pending work left to repopulate anything, and without this it boots
// into an empty account and renders nothing.
async function reseedAuth(page: Page, context: BrowserContext): Promise<void> {
  const live = await page.evaluate((k) => localStorage.getItem(k), SIA_KEY)
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
    { key: SIA_KEY, payload: live },
  )
}

test('an interrupted publish resumes from its checkpoint on reload', async ({
  browser,
}) => {
  // Re-enabled 2026-09-24. This was fixme'd because the final "post visible after
  // reload" assertion needs the feed to re-resolve alice's own channel locator, and
  // the public relays clamp a packet's TTL to a 300s floor before deciding whether to
  // serve their cache — a wait no client can shorten, since it is the relay's
  // staleness rather than ours. The relays are ours now and run a 1-5s window, so the
  // resolve is the one thing in this spec that is no longer a property of somebody
  // else's infrastructure. See scripts/relay-pkarr.toml.
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
    // The heading is the ENQUEUE. K is minted before any byte moves so the share link
    // exists immediately, which is why this is fast rather than generous.
    await expect(
      alice.getByRole('heading', { name: /Channel created/i }),
    ).toBeVisible({ timeout: 30_000 })
    // The COMMIT — see waitForChannelPublished. Load-bearing here beyond the usual
    // race: this spec goes on to hang every pkarr PUT, and the create's own locator
    // publish is a pkarr PUT. Reach the block with the create still in flight and it
    // hangs forever; the action runner is serial, so the publish under test never
    // starts and its checkpoint never lands.
    await waitForChannelPublished(alice, channelName)
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
    await reseedAuth(alice, context)

    await alice.unroute(PKARR_RELAY)
    await alice.reload()

    // Resume: hydration loads the pending checkpointed task, the runner
    // skips re-upload and completes the manifest write — the post lands.
    await expect(alice.getByText(postBody).first()).toBeVisible({
      timeout: 90_000,
    })

    // The succeeded task drains itself from IndexedDB — nothing lingers.
    // Asserted as kind:state pairs rather than a count, so a leftover says what
    // it is: only `success` drops itself, `failed` persists on purpose, and this
    // queue carries more kinds than it did when the spec was written.
    //
    // Note what the persisted `state` can and cannot say: 'running' is
    // deliberately never written to IDB (actionQueue's setState), so a record
    // reads 'pending' for the whole time it is in flight and vanishes only on
    // success. This poll therefore means "not yet succeeded" — it cannot
    // distinguish a resume that never started from one still working, which is
    // why the window has to cover a real Sia commit rather than a UI beat.
    await expect
      .poll(
        async () => {
          const q = await readQueue(alice!)
          return q.kinds.map(
            (k, i) =>
              `${k}:${q.states[i]}:${
                q.ids[i] === parked.ids[0] ? 'same-task' : 'new-task'
              }`,
          )
        },
        { timeout: 150_000, intervals: [1000] },
      )
      .toEqual([])

    // -- Reopen once more: clean slate (drained queue), no in-flight noise --
    // Reseeded again, from the state the resume produced: this boot has no
    // pending task to rebuild anything, so it is the reload that proves the
    // post survives on its own rather than on work still in the queue.
    await reseedAuth(alice, context)
    await alice.reload()
    try {
      await expect(alice.getByText(postBody).first()).toBeVisible({
        timeout: 90_000,
      })
    } catch (e) {
      // A cold boot renders this post from the network, so "not visible" has
      // several distinct causes that look identical from the assertion: the
      // channel missing from local state, a manifest resolved without the post
      // in it, or a feed that has it and doesn't collate it. Report which
      // before failing — the production build this tier serves has no __pin*
      // diagnostics, so this is the only way in.
      const diag = await alice.evaluate((k) => {
        const st = JSON.parse(localStorage.getItem(k) || '{}').state ?? {}
        return {
          myChannels: (st.myChannels ?? []).length,
          subscriptions: (st.subscriptions ?? []).length,
          username: st.profile?.username ?? null,
        }
      }, SIA_KEY)
      const onHome = await alice
        .locator('article, li')
        .allInnerTexts()
        .catch(() => [])
      console.log('[cold-boot diag] local state:', JSON.stringify(diag))
      console.log('[cold-boot diag] home rows:', onHome.length)
      console.log(
        '[cold-boot diag] home text sample:',
        JSON.stringify(onHome.slice(0, 8)),
      )
      throw e
    }

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
