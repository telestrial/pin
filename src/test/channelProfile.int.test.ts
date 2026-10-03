// A channel's page, read by somebody who may not read its posts.
//
// A private channel's profile rides in its manifest's head, readable with K, while its posts
// are sealed for members. So K alone reads the page and not the channel; a secret channel
// shows nothing at all. Sealed through the real wasm, so the split is the production one.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { newChannelKey } from '../core/channels'
import { channelKeyFromBase64 } from '../core/crypto'
import {
  isKeyNotHeld,
  resolveChannelProfile,
  resolveChannelViaLocator,
} from '../lib/channelLocator'
import { publishLocator } from '../lib/channelLocatorNative'
import { didOf } from './fakeModules'
import { createFakeApp, FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

async function published(visibility: 'public' | 'private' | 'secret') {
  createFakeApp()
  const key = await newChannelKey()
  const author = await didOf(FAKE_APP_KEY_HEX)
  await publishLocator(
    FAKE_APP_KEY_HEX,
    channelKeyFromBase64(key),
    JSON.stringify({
      version: 1,
      name: 'The back room',
      description: 'where it happens',
      authorPubkey: 'ed25519:aa',
      authorDidDht: author,
      publishedAt: '2026-10-02T00:00:00.000Z',
      visibility,
      items: [],
    }),
  )
  return { key, author }
}

describe('integration: a channel profile read with K alone', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('shows a private channel’s page and not its posts', async () => {
    const { key, author } = await published('private')

    expect(await resolveChannelProfile(key, author)).toEqual({
      name: 'The back room',
      description: 'where it happens',
      visibility: 'private',
    })
    const err = await resolveChannelViaLocator(key, author).catch((e) => e)
    expect(isKeyNotHeld(err)).toBe(true)
  })

  it('shows nothing of a secret channel', async () => {
    const { key, author } = await published('secret')
    expect(await resolveChannelProfile(key, author)).toBeNull()
  })
})
