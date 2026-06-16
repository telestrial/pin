import { Agent, AtpAgent } from '@atproto/api'
import { getChannelRecord } from './atproto'
import { deriveAtRkey } from './crypto'
import { listFollows, parseChannelAtURI } from './follow'
import type { SubscriptionRef } from './types'

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

// Resolve a followed person's claimed channels into Watch candidates. A
// person's claims are their own public follows whose subject channel is
// authored by them (the channel-as-voice self-follow written at creation) —
// the same derivation the handle directory's "Their voices" uses. Only
// PUBLIC channels qualify: their record carries K (record.key), so we can
// build a functional Watch (handle, channelID, K) without the subscribe URL.
// Obscure channels are skipped — we'd have no key to decrypt them. cachedName
// is intentionally left unset; the feed fills the display name from the
// manifest cache on first load (one fewer fetch + decrypt here).
export async function resolveAutoWatchCandidates(
  followedDID: string,
): Promise<SubscriptionRef[]> {
  // Resolve DID → handle once for this person; reused across their channels.
  let handle = followedDID
  try {
    const unauthed = new AtpAgent({ service: DEFAULT_SERVICE })
    const r = await unauthed.com.atproto.repo.describeRepo({ repo: followedDID })
    handle = r.data.handle
  } catch {
    // Fall back to the DID as the handle slot — fetchChannel/JetStream key
    // off authorDID anyway; the handle is for display + subscribe-URL text.
  }

  const follows = await listFollows(followedDID)
  const claimedChannelIDs: string[] = []
  const seen = new Set<string>()
  for (const f of follows) {
    const parsed = parseChannelAtURI(f.record.subject)
    if (!parsed) continue
    if (parsed.authorDID !== followedDID) continue // not a self-authored claim
    if (seen.has(parsed.channelID)) continue
    seen.add(parsed.channelID)
    claimedChannelIDs.push(parsed.channelID)
  }

  const addedAt = new Date().toISOString()
  const candidates = await Promise.all(
    claimedChannelIDs.map(async (channelID): Promise<SubscriptionRef | null> => {
      try {
        const record = await getChannelRecord(followedDID, channelID)
        if (!record.key) return null // obscure — no key to Watch with
        return {
          authorHandle: handle,
          authorDID: followedDID,
          channelID,
          channelKey: record.key,
          addedAt,
        }
      } catch {
        return null // unreadable record — skip, next reconcile retries
      }
    }),
  )
  return candidates.filter((c): c is SubscriptionRef => c !== null)
}

// --- Reconciliation logic (pure; network orchestration lives in the hook) ---

// The additive half of auto-Watch reconciliation. Given the channels claimed
// across all the people you handle-follow (already resolved to Watch
// candidates), the channelIDs you currently hold locally, and your tombstone
// set, return the candidates to auto-Watch now: claimed, not already present,
// not tombstoned. Deduped by channelID (a channel reached via two followed
// people is added once). Reconcile is additive only — it never removes; the
// tombstone set is how an explicit unsubscribe survives repeated boots.
export function autoWatchAdditions(
  candidates: readonly SubscriptionRef[],
  subscribedChannelIDs: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
): SubscriptionRef[] {
  const out: SubscriptionRef[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    if (subscribedChannelIDs.has(c.channelID)) continue
    if (dismissed.has(c.channelID)) continue
    if (seen.has(c.channelID)) continue
    seen.add(c.channelID)
    out.push(c)
  }
  return out
}

// The removal half, applied at unfollow time: of the channels the unfollowed
// person currently claims, which ones do we hold and should sweep out of our
// Watches. Pure intersection — the caller re-walks the unfollowed person's
// claimed channels to source `theirClaimedChannelIDs`.
export function autoWatchRemovals(
  theirClaimedChannelIDs: readonly string[],
  subscribedChannelIDs: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of theirClaimedChannelIDs) {
    if (!subscribedChannelIDs.has(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
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
