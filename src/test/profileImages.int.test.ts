// Saving a profile's images through the action journal.
//
// The form used to await two uploads inline: no progress, no retry, and a tab closed
// mid-upload left bytes in this identity's Sia scope that nothing referenced and nothing
// reclaimed. The text fields keep their inline write, being a local store patch that
// cannot fail; what moves through the journal is the unbounded half.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ProfileImagesContext,
  runProfileImages,
} from '../lib/actions/profileImages'
import {
  type ProfileImagesAction,
  type ProfileImagesIntent,
  useActionStore,
} from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import type { FakeSiaClient } from './fakeSia'
import { createFakeApp, resetAllStores } from './setupFakeApp'

const AVATAR = new Uint8Array([1, 2, 3])
const COVER = new Uint8Array([4, 5, 6])

function action(
  intent: Partial<ProfileImagesIntent>,
  ledger: ProfileImagesAction['ledger'] = {},
): ProfileImagesAction {
  return {
    id: 'act-1',
    kind: 'profile-images',
    state: 'running',
    progress: 0,
    createdAt: '2026-09-20T12:00:00.000Z',
    title: 'Profile images',
    successLabel: 'Saved',
    failLabel: 'Save',
    intent: { reclaimURLs: [], ...intent },
    ledger,
  }
}

describe('integration: profile images through the journal', () => {
  let client: FakeSiaClient
  let checkpointed: { avatarURL?: string; coverURL?: string } | null

  const ctx = (): ProfileImagesContext => ({
    client,
    setPhase: () => {},
    setProgress: () => {},
    checkpoint: (urls) => {
      checkpointed = urls
    },
  })

  beforeEach(() => {
    resetAllStores()
    checkpointed = null
    client = createFakeApp().createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    }).client
  })

  it('checkpoints the uploaded URLs before the record names them', async () => {
    // Flaky leg first. The checkpoint is what lets a resume skip the upload, and it has
    // to exist before anything points at the bytes.
    await runProfileImages(
      action({
        avatar: { bytes: AVATAR, mimeType: 'image/png' },
        cover: { bytes: COVER, mimeType: 'image/png' },
      }),
      ctx(),
    )

    expect(checkpointed?.avatarURL).toBeTruthy()
    expect(checkpointed?.coverURL).toBeTruthy()
    expect(useAuthStore.getState().profile?.avatarURL).toBe(
      checkpointed?.avatarURL,
    )
    expect(useAuthStore.getState().profile?.coverURL).toBe(
      checkpointed?.coverURL,
    )
  })

  it('packs both images into one upload', async () => {
    // Sia allocates in ~40 MiB slabs, and the two inline uploads this replaces paid for
    // one each.
    const packed = vi.spyOn(client, 'uploadItemsPacked')

    await runProfileImages(
      action({
        avatar: { bytes: AVATAR, mimeType: 'image/png' },
        cover: { bytes: COVER, mimeType: 'image/png' },
      }),
      ctx(),
    )

    expect(packed).toHaveBeenCalledTimes(1)
    expect(packed.mock.calls[0][0]).toEqual([AVATAR, COVER])
  })

  it('writes nothing and reclaims nothing when the upload fails', async () => {
    // The whole point of uploading first: a record never names bytes that did not land,
    // and an outage surfaces before anything commits.
    vi.spyOn(client, 'uploadItemsPacked').mockRejectedValue(
      new Error('host down'),
    )

    await expect(
      runProfileImages(
        action({
          avatar: { bytes: AVATAR, mimeType: 'image/png' },
          reclaimURLs: ['sia://old-avatar#encryption_key=aa'],
        }),
        ctx(),
      ),
    ).rejects.toThrow('host down')

    expect(checkpointed).toBeNull()
    expect(useAuthStore.getState().profile?.avatarURL).toBeUndefined()
    expect(useActionStore.getState().actions).toEqual([])
  })

  it('skips the upload on a resume that carries a checkpoint', async () => {
    // The bytes are STILL HERE — a retry inside the session keeps them, and only the
    // persisted copy drops them. So the checkpoint has to be what decides, or a retry
    // after a failed record write pays for the upload twice and mints a second object
    // nothing will ever reclaim.
    const packed = vi.spyOn(client, 'uploadItemsPacked')

    await runProfileImages(
      action(
        { avatar: { bytes: AVATAR, mimeType: 'image/png' } },
        { uploaded: true, avatarURL: 'sia://kept#encryption_key=bb' },
      ),
      ctx(),
    )

    expect(packed).not.toHaveBeenCalled()
    expect(useAuthStore.getState().profile?.avatarURL).toBe(
      'sia://kept#encryption_key=bb',
    )
  })

  it('journals the reclaim after the record lands', async () => {
    await runProfileImages(
      action({
        avatar: { bytes: AVATAR, mimeType: 'image/png' },
        reclaimURLs: ['sia://old-avatar#encryption_key=aa'],
      }),
      ctx(),
    )

    const reclaim = useActionStore.getState().actions
    expect(reclaim).toHaveLength(1)
    expect(reclaim[0].kind).toBe('delete-objects')
  })

  it('enqueues nothing for a save that moves no bytes', async () => {
    // A rename touches no images, and an empty action would sit in the in-flight list
    // announcing that nothing happened.
    const id = useActionStore.getState().enqueueProfileImages({
      reclaimURLs: [],
    })

    expect(id).toBe('')
    expect(useActionStore.getState().actions).toEqual([])
  })
})
