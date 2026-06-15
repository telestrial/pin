import { Agent, AtpAgent } from '@atproto/api'
import { deriveAtRkey } from './crypto'

export const HANDLEFOLLOW_LEXICON = 'dev.sia.pin.handlefollow'

const DEFAULT_SERVICE = 'https://bsky.social'

export type HandleFollowRecord = {
  $type: typeof HANDLEFOLLOW_LEXICON
  // DID of the person being followed. Unlike a channel-follow (whose
  // subject is a channel AT-URI), a handle-follow points at the whole
  // identity — auto-tracking every public channel that identity claims.
  subject: string
  createdAt: string
}

// Deterministic rkey from the followed DID so re-following an
// already-followed person is an idempotent putRecord (no duplicate), and
// unfollow is a single deleteRecord by the same derivation (no list-then-find).
// Mirrors rkeyForSubject in follow.ts.
export async function rkeyForHandleSubject(subjectDID: string): Promise<string> {
  return deriveAtRkey(subjectDID)
}

export async function followHandle(
  agent: Agent,
  subjectDID: string,
): Promise<{ uri: string; cid: string }> {
  const did = agent.assertDid
  const rkey = await rkeyForHandleSubject(subjectDID)
  const record: HandleFollowRecord = {
    $type: HANDLEFOLLOW_LEXICON,
    subject: subjectDID,
    createdAt: new Date().toISOString(),
  }
  const result = await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: HANDLEFOLLOW_LEXICON,
    rkey,
    record,
    validate: false,
  })
  return { uri: result.data.uri, cid: result.data.cid }
}

export async function unfollowHandle(
  agent: Agent,
  subjectDID: string,
): Promise<void> {
  const did = agent.assertDid
  const rkey = await rkeyForHandleSubject(subjectDID)
  await agent.com.atproto.repo.deleteRecord({
    repo: did,
    collection: HANDLEFOLLOW_LEXICON,
    rkey,
  })
}

// Does `followerDID` publicly follow this person? Deterministic rkey
// derivation means we can ask for the exact record directly — no list
// scan. 404 = not following; other errors bubble.
export async function isFollowingHandle(
  followerDID: string,
  subjectDID: string,
): Promise<boolean> {
  const rkey = await rkeyForHandleSubject(subjectDID)
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  try {
    await agent.com.atproto.repo.getRecord({
      repo: followerDID,
      collection: HANDLEFOLLOW_LEXICON,
      rkey,
    })
    return true
  } catch (err) {
    if (isRecordNotFoundError(err)) return false
    throw err
  }
}

// List every handle-follow under a given handle/DID. Unauthenticated —
// these records are public by design, same as channel-follows. Paginates
// until the cursor is exhausted.
export async function listHandleFollows(
  followerHandleOrDID: string,
): Promise<Array<{ rkey: string; record: HandleFollowRecord }>> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  const out: Array<{ rkey: string; record: HandleFollowRecord }> = []
  let cursor: string | undefined
  do {
    const result = await agent.com.atproto.repo.listRecords({
      repo: followerHandleOrDID,
      collection: HANDLEFOLLOW_LEXICON,
      cursor,
      limit: 100,
    })
    for (const r of result.data.records) {
      const rkey = r.uri.split('/').pop() ?? ''
      out.push({ rkey, record: r.value as HandleFollowRecord })
    }
    cursor = result.data.cursor
  } while (cursor)
  return out
}

// Local copy, matching follow.ts / profile.ts — small function, not worth
// a shared module yet.
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
