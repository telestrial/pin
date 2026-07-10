import { Agent, AtpAgent } from '@atproto/api'

export const PROFILE_LEXICON = 'dev.sia.pin.profile'
// Well-known rkey, parallel to app.bsky.actor.profile/self.
export const PROFILE_RKEY = 'self'

const DEFAULT_SERVICE = 'https://bsky.social'

export type ProfileRecord = {
  $type: typeof PROFILE_LEXICON
  // The self-chosen @-word: the name a person picks to represent them.
  // NON-unique, mutable, and unenforced by design — identity is the DID,
  // continuity is petname + DID, reputation is key-anchored vouches, so this
  // is purely a display/mention label carrying no structural weight. Distinct
  // from the atproto handle (`handle` everywhere else in the code), which is
  // the DID's permanent address; `username` is what the user calls themselves.
  username?: string
  displayName?: string
  bio?: string
  // Sia share URLs (with per-object encryption key in the URL fragment),
  // same shape as ChannelImage.itemURL. Bytes live on Sia, not in atproto
  // blob storage — symmetric with how channel images work.
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
  return raw
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, '')
    .slice(0, 30)
}

export async function getProfileRecord(
  authorHandleOrDID: string,
): Promise<ProfileRecord | null> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  try {
    const result = await agent.com.atproto.repo.getRecord({
      repo: authorHandleOrDID,
      collection: PROFILE_LEXICON,
      rkey: PROFILE_RKEY,
    })
    return result.data.value as ProfileRecord
  } catch (err) {
    // "No Pin profile yet" is the common case — return null so the caller
    // renders the empty state. Other errors bubble so network problems
    // stay distinguishable from missing-profile.
    if (isRecordNotFoundError(err)) return null
    throw err
  }
}

export async function putProfileRecord(
  agent: Agent,
  patch: ProfilePatch,
): Promise<ProfileRecord> {
  const did = agent.assertDid

  // Read current so we patch instead of overwriting unrelated fields.
  const current = await getProfileRecord(did)

  const next: ProfileRecord = {
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

  await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: PROFILE_LEXICON,
    rkey: PROFILE_RKEY,
    record: next,
    validate: false,
  })
  return next
}

export async function deleteProfileRecord(agent: Agent): Promise<void> {
  const did = agent.assertDid
  await agent.com.atproto.repo.deleteRecord({
    repo: did,
    collection: PROFILE_LEXICON,
    rkey: PROFILE_RKEY,
  })
}

function isRecordNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: number; error?: string; message?: string }
  if (e.error === 'RecordNotFound') return true
  if (
    e.status === 400 &&
    typeof e.message === 'string' &&
    /could not locate|not found|recordnotfound/i.test(e.message)
  ) {
    return true
  }
  return false
}
