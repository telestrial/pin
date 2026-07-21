// The profile record shape + pure helpers. Profiles are local (settings-synced)
// and published into the identity-doc on pkarr/Sia — there's no atproto profile
// record anymore; PROFILE_LEXICON survives only as the record's `$type` tag.
export const PROFILE_LEXICON = 'dev.sia.pin.profile'

export type ProfileRecord = {
  $type: typeof PROFILE_LEXICON
  // The self-chosen @-word: the name a person picks to represent them.
  // NON-unique, mutable, and unenforced by design — identity is the DID,
  // continuity is petname + DID, reputation is key-anchored vouches, so this
  // is purely a display/mention label carrying no structural weight.
  username?: string
  displayName?: string
  bio?: string
  // Sia share URLs (with per-object encryption key in the URL fragment),
  // same shape as ChannelImage.itemURL. Bytes live on Sia.
  avatarURL?: string
  coverURL?: string
  updatedAt: string
}

export type ProfilePatch = {
  username?: string
  displayName?: string
  bio?: string
  avatarURL?: string
  coverURL?: string
  // Allow callers to explicitly clear avatar/cover (distinct from "no patch").
  removeAvatar?: boolean
  removeCover?: boolean
}

// Coerce raw input into the @-word shape: a single connected token. Strips a
// leading `@` (common on paste), removes all whitespace (a handle is one
// unbroken string), caps length. Deliberately permissive on charset — the name
// is the user's, and mentions resolve through a DID-backed picker rather than
// plaintext parsing, so there's no tokenizer that needs a restricted alphabet.
// Non-uniqueness is not checked here (or anywhere) — it's unenforced by design.
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').replace(/\s+/g, '').slice(0, 30)
}

// Apply a patch to a profile: undefined fields keep the current value;
// removeAvatar/removeCover explicitly clear. The store holds the result locally
// and the identity-doc publisher pushes it.
export function applyProfilePatch(
  current: ProfileRecord | null,
  patch: ProfilePatch,
): ProfileRecord {
  return {
    $type: PROFILE_LEXICON,
    username: patch.username ?? current?.username,
    displayName: patch.displayName ?? current?.displayName,
    bio: patch.bio ?? current?.bio,
    avatarURL: patch.removeAvatar
      ? undefined
      : (patch.avatarURL ?? current?.avatarURL),
    coverURL: patch.removeCover
      ? undefined
      : (patch.coverURL ?? current?.coverURL),
    updatedAt: new Date().toISOString(),
  }
}
