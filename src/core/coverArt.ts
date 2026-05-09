import type { Sdk } from '@siafoundation/sia-storage'
import type { ChannelManifest } from './types'

export type CoverArtResolution = {
  objectID: string
  itemURL: string
}

export type CoverArtResolveResult = {
  resolved: Map<string, CoverArtResolution>
  failed: { channelID: string; error: unknown }[]
}

// Cover art lives in the manifest as a share URL only — the caller's
// own object scope doesn't have the cover's object ID until we resolve
// it via sharedObject(url).id(). Repack, orphan sweep, and the slab
// inspector all need this for owned channels; only their post-success
// handling differs (sweep bails on any failure, repack and inspector
// continue without the failed channel's cover).
export async function resolveCoverArtIDs(
  sdk: Sdk,
  channels: ReadonlyArray<{ channelID: string }>,
  manifests: Record<string, ChannelManifest>,
): Promise<CoverArtResolveResult> {
  const resolved = new Map<string, CoverArtResolution>()
  const failed: { channelID: string; error: unknown }[] = []

  await Promise.all(
    channels.map(async (channel) => {
      const manifest = manifests[channel.channelID]
      if (!manifest?.coverArt) return
      try {
        const obj = await sdk.sharedObject(manifest.coverArt.itemURL)
        resolved.set(channel.channelID, {
          objectID: obj.id(),
          itemURL: manifest.coverArt.itemURL,
        })
      } catch (error) {
        failed.push({ channelID: channel.channelID, error })
      }
    }),
  )

  return { resolved, failed }
}
