import { Agent, AtpAgent } from '@atproto/api'
import { CHANNEL_LEXICON } from './atproto'
import { deriveAtRkey } from './crypto'

export const SUBSCRIPTION_LEXICON = 'dev.sia.pin.subscription'

const DEFAULT_SERVICE = 'https://bsky.social'

export type SubscriptionRecord = {
  $type: typeof SUBSCRIPTION_LEXICON
  // AT-URI of the channel record being followed:
  //   at://<channel-authorDID>/dev.sia.pin.channel/<channelID>
  subject: string
  createdAt: string
}

export function channelAtURI(
  channelAuthorDID: string,
  channelID: string,
): string {
  return `at://${channelAuthorDID}/${CHANNEL_LEXICON}/${channelID}`
}

// Deterministic rkey from subject so re-following an already-followed
// channel is an idempotent putRecord (no duplicate), and unfollow is a
// single deleteRecord call by the same derivation (no list-then-find).
export async function rkeyForSubject(subject: string): Promise<string> {
  return deriveAtRkey(subject)
}

export async function follow(
  agent: Agent,
  channelAuthorDID: string,
  channelID: string,
): Promise<{ uri: string; cid: string }> {
  const did = agent.assertDid
  const subject = channelAtURI(channelAuthorDID, channelID)
  const rkey = await rkeyForSubject(subject)
  const record: SubscriptionRecord = {
    $type: SUBSCRIPTION_LEXICON,
    subject,
    createdAt: new Date().toISOString(),
  }
  const result = await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: SUBSCRIPTION_LEXICON,
    rkey,
    record,
    validate: false,
  })
  return { uri: result.data.uri, cid: result.data.cid }
}

export async function unfollow(
  agent: Agent,
  channelAuthorDID: string,
  channelID: string,
): Promise<void> {
  const did = agent.assertDid
  const subject = channelAtURI(channelAuthorDID, channelID)
  const rkey = await rkeyForSubject(subject)
  await agent.com.atproto.repo.deleteRecord({
    repo: did,
    collection: SUBSCRIPTION_LEXICON,
    rkey,
  })
}

// Does `followerDID` publicly follow this channel? Deterministic rkey
// derivation means we can ask for the exact record directly — no list
// scan. 404 = not following; other errors bubble.
export async function isFollowing(
  followerDID: string,
  channelAuthorDID: string,
  channelID: string,
): Promise<boolean> {
  const subject = channelAtURI(channelAuthorDID, channelID)
  const rkey = await rkeyForSubject(subject)
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  try {
    await agent.com.atproto.repo.getRecord({
      repo: followerDID,
      collection: SUBSCRIPTION_LEXICON,
      rkey,
    })
    return true
  } catch (err) {
    if (isRecordNotFoundError(err)) return false
    throw err
  }
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

// List every public follow under a given handle/DID. Unauthenticated —
// these records are public by design (that's the whole point of Follow
// vs the local-only Watch verb). Paginates until the cursor is exhausted.
export async function listFollows(
  authorHandleOrDID: string,
): Promise<Array<{ rkey: string; record: SubscriptionRecord }>> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  const out: Array<{ rkey: string; record: SubscriptionRecord }> = []
  let cursor: string | undefined
  do {
    const result = await agent.com.atproto.repo.listRecords({
      repo: authorHandleOrDID,
      collection: SUBSCRIPTION_LEXICON,
      cursor,
      limit: 100,
    })
    for (const r of result.data.records) {
      const rkey = r.uri.split('/').pop() ?? ''
      out.push({ rkey, record: r.value as SubscriptionRecord })
    }
    cursor = result.data.cursor
  } while (cursor)
  return out
}

// Parse a channel AT-URI back into (authorDID, channelID). Returns null
// if the URI shape doesn't match (subject from a different lexicon, malformed,
// etc.). Callers walking listFollows results use this to resolve each
// follow back to a channel for rendering.
export function parseChannelAtURI(
  uri: string,
): { authorDID: string; channelID: string } | null {
  const m = uri.match(
    new RegExp(`^at://([^/]+)/${CHANNEL_LEXICON.replace(/\./g, '\\.')}/([^/]+)$`),
  )
  if (!m) return null
  return { authorDID: m[1], channelID: m[2] }
}
