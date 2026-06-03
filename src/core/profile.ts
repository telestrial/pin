import { Agent, AtpAgent } from '@atproto/api'

export const PROFILE_LEXICON = 'dev.sia.pin.profile'
// Well-known rkey, parallel to app.bsky.actor.profile/self.
export const PROFILE_RKEY = 'self'

const DEFAULT_SERVICE = 'https://bsky.social'

export type ProfileRecord = {
  $type: typeof PROFILE_LEXICON
  displayName?: string
  bio?: string
  // Sia share URLs (with per-object encryption key in the URL fragment),
  // same shape as ChannelCover.itemURL. Bytes live on Sia, not in atproto
  // blob storage — symmetric with how channel covers work.
  avatarURL?: string
  coverURL?: string
  updatedAt: string
}

export type ProfilePatch = {
  displayName?: string
  bio?: string
  avatarURL?: string
  coverURL?: string
  // Allow callers to explicitly clear avatar/cover (distinct from "no patch").
  removeAvatar?: boolean
  removeCover?: boolean
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
