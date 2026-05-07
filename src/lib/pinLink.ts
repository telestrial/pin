import type { PinnedItemRef } from '../stores/pin'
import { LIBRARY_CHANNEL } from './pinUpload'

// Pin-flavored citation URL. Three shapes, all `pin://`-prefixed.
//
// Owned-channel items (caller passes the channel's K):
//   pin://<authorHandle>/<channelID>/<itemID>#k=<base64-K>
//
// Self-contained capability — anyone with the link resolves it without
// needing prior subscription to the channel. K decrypts the manifest
// → find item by `id` → fetch via the manifest's stored Sia URL. Same
// shape as a Sia URL with its key in the fragment, one layer up. K is
// only ever embedded for channels the user owns; sharing your own K
// is your call. Citation = re-share, deliberate.
//
// Other-channel items (no K passed):
//   pin://<authorHandle>/<channelID>/<itemID>
//
// Bare form — preserves the "K is a deliberate share" property for
// channels the user doesn't own. Resolution requires the reader to
// already hold K (i.e., subscribe to the cited channel separately).
//
// Library items (no channel manifest backing them):
//   pin://item/<base64url-encoded Sia share URL>
//
// Embedded Sia URL — anyone can extract and fetch bytes via Sia
// directly. The `item` host segment is unambiguous as a library-link
// marker because atproto handles must contain a dot.
export function buildPinLink(
  ref: PinnedItemRef,
  ownChannelKey?: string,
): string {
  if (ref.channel.channelID === LIBRARY_CHANNEL.channelID) {
    return `pin://item/${base64url(ref.item.itemURL)}`
  }
  const base = `pin://${ref.channel.authorHandle}/${ref.channel.channelID}/${ref.item.id}`
  return ownChannelKey ? `${base}#k=${ownChannelKey}` : base
}

function base64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
