// Sentinel "channel" used for items uploaded directly to the user's library
// (compose forms' pin button) — the bytes live in the user's Sia scope but
// were never published to a channel manifest. Keeps the PinnedItemRef shape
// uniform with channel-published pins; the channelID is a literal string the
// rest of the UI doesn't expect to find in any manifest.
export const LIBRARY_CHANNEL = {
  authorHandle: '',
  channelID: 'library',
  name: 'Library',
}
