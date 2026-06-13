import { type ChannelManifest, isValidAttachment } from '../core/types'

// Sia object IDs referenced by a set of channel manifests — each item's body
// (item.id) plus its attachment objectIDs. Used to refcount the author's own
// scope before an eager retract: a file referenced by another of your posts
// must not be deleted out from under it. Pass excludeChannelID to drop the
// channel being edited — the caller supplies that channel's post-edit state
// separately (the retract function already holds the fresh manifest).
//
// Channel cover/avatar images are intentionally omitted: ChannelImage carries
// no objectID, and there's no realistic path for a post body/attachment to
// share an object with a cover. Legacy attachments without objectID are
// skipped too (can't be matched in-memory); the orphan sweep stays the
// backstop for anything this misses.
export function objectIDsInManifests(
  manifests: Record<string, ChannelManifest>,
  excludeChannelID?: string,
): Set<string> {
  const set = new Set<string>()
  for (const [channelID, manifest] of Object.entries(manifests)) {
    if (channelID === excludeChannelID) continue
    for (const item of manifest.items) {
      set.add(item.id)
      for (const att of item.attachments ?? []) {
        if (isValidAttachment(att) && att.objectID) set.add(att.objectID)
      }
    }
  }
  return set
}
