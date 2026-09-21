import type { SiaClient } from '../../core/siaClient'
import type { ChannelImage } from '../../core/types'
import {
  type ChannelEditAction,
  useActionStore,
} from '../../stores/actionQueue'
import { useAuthStore } from '../../stores/auth'
import { saveChannelEdits } from '../channelWrites'

// Saving a channel's settings, as a resumable action.
//
// The form awaited this inline: an avatar and a cover uploaded one apiece, then the
// manifest commit, with a spinner and no retry. A tab closed mid-upload left image bytes
// in this identity's scope that no manifest named and no mark reclaimed, and a failed
// commit lost the edit with the page.
//
// Flaky leg first, as everywhere: the images go up and their URLs are checkpointed before
// the manifest names them, so a resume commits the images it already paid for. The
// manifest commit itself is the reliable leg — `commitChannelManifest` is done only when
// the Sia object and the pkarr pointer are both live.
//
// PACKED, so an avatar and a cover share one slab instead of one each.

export type ChannelEditContext = {
  client: SiaClient
  setPhase: (phase: string, progress?: number) => void
  setProgress: (progress: number) => void
  checkpoint: (images: { avatar?: ChannelImage; cover?: ChannelImage }) => void
}

export async function runChannelEdit(
  action: ChannelEditAction,
  ctx: ChannelEditContext,
): Promise<void> {
  const { client, setPhase, setProgress, checkpoint } = ctx
  const intent = action.intent
  let { avatar, cover } = action.ledger

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
      const expected = 30
      const uploaded = await client.uploadItemsPacked(bytes, () => {
        shards += 1
        setProgress(Math.min(95, (shards / expected) * 100))
      })
      pending.forEach((which, i) => {
        const image: ChannelImage = {
          itemURL: uploaded[i].itemURL,
          mimeType:
            which === 'avatar'
              ? (intent.avatar?.mimeType ?? '')
              : (intent.cover?.mimeType ?? ''),
          contentHash: uploaded[i].contentHash,
          byteSize: bytes[i].length,
        }
        if (which === 'avatar') avatar = image
        else cover = image
      })
    }
    checkpoint({ avatar, cover })
  }

  setPhase('Saving', 97)
  const { manifest, reclaimURLs } = await saveChannelEdits(
    client,
    { channelID: intent.channelID, channelKey: intent.channelKey },
    {
      name: intent.name,
      description: intent.description,
      comments: intent.comments,
      avatar,
      cover,
      removeAvatar: intent.removeAvatar,
      removeCover: intent.removeCover,
    },
  )

  const auth = useAuthStore.getState()
  // The manifest is what these cache, so they are set from what it says rather than from
  // what was asked for.
  if (intent.name) {
    auth.updateMyChannelName(intent.channelID, manifest.name)
    auth.updateSubscriptionName(intent.channelID, manifest.name)
  }
  // Backfill visibility for channels created before settings recorded it. Sticky, so this
  // only ever writes down what the manifest already says — and until it is written, the
  // identity publisher won't advertise the channel, because it can't tell public from
  // obscure.
  if (manifest.visibility)
    auth.setChannelVisibility(intent.channelID, manifest.visibility)

  if (reclaimURLs.length > 0) {
    useActionStore.getState().enqueueDeleteObjects({
      urls: reclaimURLs,
      label: 'Reclaiming old channel image',
    })
  }
}
