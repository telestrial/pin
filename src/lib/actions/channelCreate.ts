import type { SiaClient } from '../../core/siaClient'
import type { ChannelImage } from '../../core/types'
import type { ChannelCreateAction } from '../../stores/actionQueue'
import { useAuthStore } from '../../stores/auth'
import { createAndPublishChannel } from '../channelWrites'
import { flushSettingsBestEffort } from '../hooks/useSettingsSync'

// Creating a channel, as a resumable action.
//
// Images first and the manifest after, as everywhere; what is particular here is that the
// channel's IDENTITY is decided before any of it. `channelKey` and `channelID` are minted
// at enqueue and carried in the intent, so every run of this writes the same channel to
// the same locator. A handler minting its own would answer a retry with a second channel
// and leave the first one's images paid for and unreferenced.
//
// The settings entry lands AFTER the commit. It could be written at enqueue for a sidebar
// that fills in instantly, and that is what the profile and the channel edit do with
// their cached names — but a channel in settings is a channel the identity loop
// advertises, and advertising one whose manifest has not been published sends readers to
// a locator that resolves to nothing.

export type ChannelCreateContext = {
  client: SiaClient
  setPhase: (phase: string, progress?: number) => void
  setProgress: (progress: number) => void
  checkpoint: (images: { avatar?: ChannelImage; cover?: ChannelImage }) => void
}

export async function runChannelCreate(
  action: ChannelCreateAction,
  ctx: ChannelCreateContext,
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

  setPhase('Creating', 97)
  const created = await createAndPublishChannel(client, {
    channelKey: intent.channelKey,
    name: intent.name,
    description: intent.description,
    visibility: intent.visibility,
    avatar,
    cover,
    authorDidDht: intent.authorDidDht,
  })

  const auth = useAuthStore.getState()
  auth.addMyChannel({
    channelID: created.channelID,
    channelKey: created.channelKey,
    name: created.manifest.name,
    createdAt: created.manifest.publishedAt,
    visibility: intent.visibility,
    // Recorded only when turned off, so the setting reads the same as a channel made
    // before it existed.
    ...(intent.showOnProfile ? {} : { showOnProfile: false }),
  })
  auth.addSubscription({
    // did:dht is the identity now; the legacy atproto handle/DID fields stay on the type
    // but are empty for did:dht-native subscriptions.
    authorHandle: '',
    authorDID: '',
    didDht: intent.authorDidDht,
    channelID: created.channelID,
    channelKey: created.channelKey,
    cachedName: created.manifest.name,
    addedAt: new Date().toISOString(),
    label: created.manifest.name,
  })
  // Awaited, so the channel is durable before this reports done — a reload inside the
  // mirror's debounce used to drop it from the list while the manifest stayed published.
  await flushSettingsBestEffort()
}
