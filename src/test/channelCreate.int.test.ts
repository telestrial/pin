// Creating a channel through the action journal.
//
// The form awaited the images, the manifest and the settings flush inline, so a tab
// closed mid-upload left image bytes nothing named and a failed commit lost the whole
// channel. What makes this resumable at all is that the channel's identity is decided
// before any of it: K is minted at enqueue and carried in the intent, so every run writes
// the same channel to the same locator.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { channelKeyFromBase64, deriveChannelID } from '../core/crypto'
import {
  type ChannelCreateContext,
  runChannelCreate,
} from '../lib/actions/channelCreate'
import type { ChannelCreateAction } from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import type { FakeAccount } from './setupFakeApp'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const AVATAR = new Uint8Array([1, 2, 3])
const COVER = new Uint8Array([4, 5, 6])

describe('integration: creating a channel through the journal', () => {
  let author: FakeAccount
  let channelKey: string
  let channelID: string
  let checkpoints: number

  const action = (
    over: Partial<ChannelCreateAction['intent']> = {},
    ledger: ChannelCreateAction['ledger'] = {},
  ): ChannelCreateAction => ({
    id: 'act-1',
    kind: 'channel-create',
    state: 'running',
    progress: 0,
    createdAt: '2026-09-20T12:00:00.000Z',
    title: 'A channel',
    successLabel: 'Created',
    failLabel: 'Create',
    intent: {
      channelKey,
      channelID,
      name: 'A channel',
      description: 'about it',
      visibility: 'public',
      showOnProfile: true,
      authorDidDht: 'did:dht:alice',
      ...over,
    },
    ledger,
  })

  const ctx = (a: ChannelCreateAction): ChannelCreateContext => ({
    client: author.client,
    setPhase: () => {},
    setProgress: () => {},
    checkpoint: (images) => {
      checkpoints += 1
      a.ledger = { ...images, uploaded: true }
    },
  })

  beforeEach(async () => {
    resetAllStores()
    checkpoints = 0
    author = createFakeApp().createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    mountAs(author)
    channelKey = await newChannelKey()
    channelID = await deriveChannelID(channelKeyFromBase64(channelKey))
  })

  // A module spy on the locator outlives its test otherwise; the client spies do not,
  // each test getting a fresh account.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates one channel however many times it runs', async () => {
    // The resume case, and the reason K is minted at enqueue. A handler minting its own
    // would answer this with a second channel at a second address, leaving the first
    // one's images paid for and referenced by nothing.
    const a = action()
    await runChannelCreate(a, ctx(a))
    await runChannelCreate(a, ctx(a))

    const mine = useAuthStore.getState().myChannels
    expect(mine).toHaveLength(1)
    expect(mine[0].channelID).toBe(channelID)
    expect(useAuthStore.getState().subscriptions).toHaveLength(1)
  })

  it('publishes the channel at the address the intent named', async () => {
    // The subscribe URL is handed over at enqueue, so the channel has to land where that
    // URL points rather than wherever the handler happened to put it.
    const a = action()
    await runChannelCreate(a, ctx(a))

    const manifest = useFeedStore.getState().manifests[channelID]
    expect(manifest.name).toBe('A channel')
    expect(manifest.description).toBe('about it')
    expect(manifest.visibility).toBe('public')
  })

  it('checkpoints the uploaded images before the manifest names them', async () => {
    const a = action({
      avatar: { bytes: AVATAR, mimeType: 'image/png' },
      cover: { bytes: COVER, mimeType: 'image/png' },
    })

    await runChannelCreate(a, ctx(a))

    expect(checkpoints).toBe(1)
    const manifest = useFeedStore.getState().manifests[channelID]
    expect(manifest.avatar?.itemURL).toBe(a.ledger.avatar?.itemURL)
    expect(manifest.cover?.itemURL).toBe(a.ledger.cover?.itemURL)
  })

  it('records nothing in settings when the upload fails', async () => {
    // Nothing partial: a channel in settings is a channel the identity loop advertises,
    // and advertising one with no manifest sends readers to a locator naming nothing.
    vi.spyOn(author.client, 'uploadItemsPacked').mockRejectedValue(
      new Error('host down'),
    )
    const a = action({ avatar: { bytes: AVATAR, mimeType: 'image/png' } })

    await expect(runChannelCreate(a, ctx(a))).rejects.toThrow('host down')

    expect(useAuthStore.getState().myChannels).toEqual([])
    expect(useFeedStore.getState().manifests[channelID]).toBeUndefined()
  })

  it('records nothing in settings when the commit fails', async () => {
    // The images are up and the checkpoint is written; what fails is the manifest. The
    // settings entry has to come after that, because a channel in settings is one the
    // identity loop advertises, and advertising one whose locator resolves to nothing
    // sends every reader to a dead end.
    const locator = await import('../lib/channelLocator')
    vi.spyOn(locator, 'commitChannelManifest').mockRejectedValue(
      new Error('locator refused'),
    )
    const a = action({ avatar: { bytes: AVATAR, mimeType: 'image/png' } })

    await expect(runChannelCreate(a, ctx(a))).rejects.toThrow('locator refused')

    expect(checkpoints).toBe(1)
    expect(useAuthStore.getState().myChannels).toEqual([])
    expect(useAuthStore.getState().subscriptions).toEqual([])
  })

  it('skips the upload on a resume that carries a checkpoint', async () => {
    const packed = vi.spyOn(author.client, 'uploadItemsPacked')
    const a = action(
      { avatar: { bytes: AVATAR, mimeType: 'image/png' } },
      {
        uploaded: true,
        avatar: {
          itemURL: 'sia://kept#encryption_key=aa',
          mimeType: 'image/png',
        },
      },
    )

    await runChannelCreate(a, ctx(a))

    expect(packed).not.toHaveBeenCalled()
    expect(useFeedStore.getState().manifests[channelID].avatar?.itemURL).toBe(
      'sia://kept#encryption_key=aa',
    )
  })

  it('records showOnProfile only when it is off', async () => {
    // Absent reads as on, so an ordinary channel adds nothing to the blob the whole
    // graph downloads to read a display name.
    const on = action()
    await runChannelCreate(on, ctx(on))

    // A second channel, so the two answers sit side by side in one settings record.
    const otherKey = await newChannelKey()
    const off = action({
      channelKey: otherKey,
      channelID: await deriveChannelID(channelKeyFromBase64(otherKey)),
      name: 'Kept off',
      showOnProfile: false,
    })
    await runChannelCreate(off, ctx(off))

    const mine = useAuthStore.getState().myChannels
    expect(
      mine.find((c) => c.name === 'A channel')?.showOnProfile,
    ).toBeUndefined()
    expect(mine.find((c) => c.name === 'Kept off')?.showOnProfile).toBe(false)
  })
})
