import type { Sdk } from '@siafoundation/sia-storage'
import type { ChannelManifest } from './types'

export type ChannelImageKind = 'avatar' | 'cover'

export type ChannelImageResolution = {
  channelID: string
  kind: ChannelImageKind
  objectID: string
  itemURL: string
}

export type ChannelImageResolveResult = {
  resolved: ChannelImageResolution[]
  failed: { channelID: string; kind: ChannelImageKind; error: unknown }[]
}

// Channel images (avatar + cover banner) live in the manifest as share URLs
// only — the caller's own object scope doesn't have their object IDs until we
// resolve them via sharedObject(url).id(). Repack, orphan sweep, and the slab
// inspector all need these object IDs for owned channels; only their
// post-success handling differs (sweep bails on any failure, repack and
// inspector continue without the failed image). Resolves BOTH images per
// channel and returns a flat list.
export async function resolveChannelImageIDs(
  sdk: Sdk,
  channels: ReadonlyArray<{ channelID: string }>,
  manifests: Record<string, ChannelManifest>,
): Promise<ChannelImageResolveResult> {
  const resolved: ChannelImageResolution[] = []
  const failed: { channelID: string; kind: ChannelImageKind; error: unknown }[] =
    []

  await Promise.all(
    channels.map(async (channel) => {
      const manifest = manifests[channel.channelID]
      if (!manifest) return
      const kinds: ChannelImageKind[] = ['avatar', 'cover']
      for (const kind of kinds) {
        const image = manifest[kind]
        if (!image) continue
        try {
          const obj = await sdk.sharedObject(image.itemURL)
          resolved.push({
            channelID: channel.channelID,
            kind,
            objectID: obj.id(),
            itemURL: image.itemURL,
          })
        } catch (error) {
          failed.push({ channelID: channel.channelID, kind, error })
        }
      }
    }),
  )

  return { resolved, failed }
}
