import type { SiaClient } from '../../core/siaClient'
import {
  type ProfileImagesAction,
  useActionStore,
} from '../../stores/actionQueue'
import { useAuthStore } from '../../stores/auth'

// The byte half of saving a profile.
//
// Flaky leg first, the same ordering every create in this codebase takes: the images go
// to Sia and the checkpoint records their URLs BEFORE the record naming them is written,
// so a record never points at bytes that failed to land and an outage surfaces before
// anything commits. A resume with a checkpoint skips the upload entirely.
//
// The text fields are not here. They are a local store write that cannot fail, so
// `EditProfile` applies them at enqueue and the name on your own profile changes the
// moment you save rather than when Sia is done.
//
// PACKED, so an avatar and a cover share one slab. Sia allocates in ~40 MiB slabs and the
// two uploads this replaces paid for one each.

export type ProfileImagesContext = {
  client: SiaClient
  setPhase: (phase: string, progress?: number) => void
  setProgress: (progress: number) => void
  checkpoint: (urls: { avatarURL?: string; coverURL?: string }) => void
}

export async function runProfileImages(
  action: ProfileImagesAction,
  ctx: ProfileImagesContext,
): Promise<void> {
  const { client, setPhase, setProgress, checkpoint } = ctx
  const intent = action.intent
  let { avatarURL, coverURL } = action.ledger

  if (!action.ledger.uploaded) {
    const pending: ('avatar' | 'cover')[] = []
    const bytes: Uint8Array[] = []
    if (intent.avatar) {
      pending.push('avatar')
      bytes.push(intent.avatar.bytes)
    }
    if (intent.cover) {
      pending.push('cover')
      bytes.push(intent.cover.bytes)
    }

    if (bytes.length > 0) {
      setPhase('Uploading', 0)
      let shards = 0
      // A rough denominator: one slab's worth of shards covers the images this form
      // accepts, and the bar is capped below 100 until the record lands anyway.
      const expected = 30
      const uploaded = await client.uploadItemsPacked(bytes, () => {
        shards += 1
        setProgress(Math.min(95, (shards / expected) * 100))
      })
      pending.forEach((which, i) => {
        if (which === 'avatar') avatarURL = uploaded[i].itemURL
        else coverURL = uploaded[i].itemURL
      })
    }
    checkpoint({ avatarURL, coverURL })
  }

  setPhase('Saving', 97)
  // Patch-merge, so this names only what it decided. The text fields went in at enqueue
  // and are not restated here, where a stale copy of them could overwrite a later edit.
  useAuthStore.getState().setProfile({
    ...(avatarURL ? { avatarURL } : {}),
    ...(coverURL ? { coverURL } : {}),
    ...(intent.removeAvatar && !avatarURL ? { removeAvatar: true } : {}),
    ...(intent.removeCover && !coverURL ? { removeCover: true } : {}),
  })

  // Reliable leg first, then the flaky cleanup drains behind it — the ordering every
  // delete here takes. Per-object Sia encryption makes each image's id unique, so
  // nothing else can be pointing at what this orphaned.
  if (intent.reclaimURLs.length > 0) {
    useActionStore.getState().enqueueDeleteObjects({
      urls: intent.reclaimURLs,
      label: 'Reclaiming old profile image',
    })
  }
}
