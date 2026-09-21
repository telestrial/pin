// Saving a channel's settings through the action journal.
//
// The form awaited two image uploads and a manifest commit inline, so a tab closed
// mid-upload left image bytes in this identity's Sia scope that no manifest named and no
// mark reclaimed, and a failed commit lost the edit with the page.

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

import {
  type ChannelEditContext,
  runChannelEdit,
} from '../lib/actions/channelEdit'
import type { ChannelEditAction } from '../stores/actionQueue'
import { useActionStore } from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import type { FakeAccount } from './setupFakeApp'
import {
  authorCreateChannel,
  createFakeApp,
  mountAs,
  resetAllStores,
} from './setupFakeApp'

const AVATAR = new Uint8Array([1, 2, 3])
const COVER = new Uint8Array([4, 5, 6])

describe('integration: a channel edit through the journal', () => {
  let author: FakeAccount
  let channelID: string
  let channelKey: string
  let checkpoints: ChannelEditAction['ledger'][]

  const action = (
    over: Partial<ChannelEditAction['intent']> = {},
    ledger: ChannelEditAction['ledger'] = {},
  ): ChannelEditAction => ({
    id: 'act-1',
    kind: 'channel-edit',
    state: 'running',
    progress: 0,
    createdAt: '2026-09-20T12:00:00.000Z',
    title: 'A channel',
    successLabel: 'Saved',
    failLabel: 'Save',
    intent: { channelID, channelKey, ...over },
    ledger,
  })

  const ctx = (): ChannelEditContext => ({
    client: author.client,
    setPhase: () => {},
    setProgress: () => {},
    checkpoint: (images) => {
      checkpoints.push({ ...images, uploaded: true })
    },
  })

  beforeEach(async () => {
    resetAllStores()
    checkpoints = []
    author = createFakeApp().createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    })
    mountAs(author)
    const created = await authorCreateChannel(author, { name: 'A channel' })
    channelID = created.channelID
    channelKey = created.channelKey
    useFeedStore.getState().setManifest(channelID, created.manifest)
    useAuthStore.setState({
      myChannels: [
        {
          channelID,
          channelKey,
          name: 'A channel',
          createdAt: created.manifest.publishedAt,
        },
      ],
    })
  })

  it('checkpoints the uploaded images before the manifest names them', async () => {
    await runChannelEdit(
      action({
        avatar: { bytes: AVATAR, mimeType: 'image/png' },
        cover: { bytes: COVER, mimeType: 'image/png' },
      }),
      ctx(),
    )

    expect(checkpoints).toHaveLength(1)
    const manifest = useFeedStore.getState().manifests[channelID]
    expect(manifest.avatar?.itemURL).toBe(checkpoints[0].avatar?.itemURL)
    expect(manifest.cover?.itemURL).toBe(checkpoints[0].cover?.itemURL)
    // The mime type comes from the picked file, which only the intent knows — the
    // upload answers with a URL and a hash.
    expect(manifest.avatar?.mimeType).toBe('image/png')
  })

  it('packs both images into one upload', async () => {
    // Sia allocates in ~40 MiB slabs, and the two inline uploads this replaces paid for
    // one each.
    const packed = vi.spyOn(author.client, 'uploadItemsPacked')

    await runChannelEdit(
      action({
        avatar: { bytes: AVATAR, mimeType: 'image/png' },
        cover: { bytes: COVER, mimeType: 'image/png' },
      }),
      ctx(),
    )

    expect(packed).toHaveBeenCalledTimes(1)
    expect(packed.mock.calls[0][0]).toEqual([AVATAR, COVER])
  })

  it('commits nothing when the upload fails', async () => {
    vi.spyOn(author.client, 'uploadItemsPacked').mockRejectedValue(
      new Error('host down'),
    )

    await expect(
      runChannelEdit(
        action({
          name: 'Renamed',
          avatar: { bytes: AVATAR, mimeType: 'image/png' },
        }),
        ctx(),
      ),
    ).rejects.toThrow('host down')

    expect(useFeedStore.getState().manifests[channelID].name).toBe('A channel')
    expect(checkpoints).toEqual([])
  })

  it('skips the upload on a resume that carries a checkpoint', async () => {
    // The bytes are still on the action — only the persisted copy drops them — so the
    // checkpoint has to be what decides, or a retry mints a second object nothing will
    // reclaim.
    const packed = vi.spyOn(author.client, 'uploadItemsPacked')

    await runChannelEdit(
      action(
        { avatar: { bytes: AVATAR, mimeType: 'image/png' } },
        {
          uploaded: true,
          avatar: {
            itemURL: 'sia://kept#encryption_key=aa',
            mimeType: 'image/png',
          },
        },
      ),
      ctx(),
    )

    expect(packed).not.toHaveBeenCalled()
    expect(useFeedStore.getState().manifests[channelID].avatar?.itemURL).toBe(
      'sia://kept#encryption_key=aa',
    )
  })

  it('journals the reclaim of the image it replaced', async () => {
    await runChannelEdit(
      action({ avatar: { bytes: AVATAR, mimeType: 'image/png' } }),
      ctx(),
    )
    const first = useFeedStore.getState().manifests[channelID].avatar?.itemURL

    await runChannelEdit(
      action({ avatar: { bytes: COVER, mimeType: 'image/png' } }),
      ctx(),
    )

    const reclaim = useActionStore
      .getState()
      .actions.filter((a) => a.kind === 'delete-objects')
    expect(reclaim).toHaveLength(1)
    expect(
      reclaim[0].kind === 'delete-objects' ? reclaim[0].intent.urls : [],
    ).toEqual([first])
  })

  it('sets the cached channel name from what the manifest ends up saying', async () => {
    await runChannelEdit(action({ name: 'Renamed' }), ctx())

    expect(useAuthStore.getState().myChannels[0].name).toBe('Renamed')
    expect(useFeedStore.getState().manifests[channelID].name).toBe('Renamed')
  })
})
