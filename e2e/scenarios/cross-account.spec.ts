// E2E happy-path: alice creates a channel and publishes a post in her
// browser context; bob subscribes via URL in his context; bob's feed
// shows alice's post.
//
// Runs against a built `dist/` served by `bun run preview --port 4173`,
// using real Sia hosts + real bsky.social. The single test in this file
// is the reconciliation point for our fake-SDK contract — if the fake
// drifts from real SDK behavior, this test fails and we fix the fake.

import { expect, test } from '@playwright/test'
import { join } from 'node:path'

const ALICE_FIXTURE = join(import.meta.dirname, '..', '.auth', 'alice.json')
const BOB_FIXTURE = join(import.meta.dirname, '..', '.auth', 'bob.json')

test('alice publishes a post; bob subscribes via URL and sees it', async ({
  browser,
}) => {
  const aliceContext = await browser.newContext({
    storageState: ALICE_FIXTURE,
  })
  const bobContext = await browser.newContext({ storageState: BOB_FIXTURE })

  const alice = await aliceContext.newPage()
  const bob = await bobContext.newPage()

  // Alice creates a fresh channel and publishes a post.
  await alice.goto('/')
  await alice.getByRole('button', { name: /Create a channel/i }).click()

  const channelName = `e2e test ${Date.now()}`
  await alice.getByLabel(/name/i).fill(channelName)
  await alice.getByRole('button', { name: /Create channel/i }).click()

  // After creation alice lands back at home with the channel selected;
  // grab the subscribe URL from the channel-share affordance.
  const subscribeURLInput = alice.getByRole('textbox', { name: /subscribe url/i })
  await expect(subscribeURLInput).toBeVisible({ timeout: 10_000 })
  const subscribeURL = await subscribeURLInput.inputValue()
  expect(subscribeURL).toMatch(/^pin:\/\//)

  const postBody = `Hello from alice — ${Date.now()}`
  // Compose textarea lives at the top of the populated home feed.
  await alice.getByPlaceholder(/What are you thinking about/i).fill(postBody)
  await alice.getByRole('button', { name: /Publish/i }).click()

  // Wait for the upload queue runner to finish — the post should appear
  // in alice's own feed once the manifest commit lands.
  await expect(alice.getByText(postBody)).toBeVisible({ timeout: 60_000 })

  // Bob subscribes to alice's channel via the URL.
  await bob.goto('/')
  await bob.getByRole('button', { name: /Subscribe/i }).click()
  await bob.getByLabel(/subscribe url/i).fill(subscribeURL)
  await bob.getByRole('button', { name: /Subscribe/i }).last().click()

  // Bob's feed populates from the encrypted ATProto record + Sia bytes.
  // Allow a generous timeout — real hosts, real network.
  await expect(bob.getByText(postBody)).toBeVisible({ timeout: 60_000 })
  await expect(bob.getByText(channelName)).toBeVisible()

  await aliceContext.close()
  await bobContext.close()
})
