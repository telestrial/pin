import { AtpAgent, type AtpSessionData } from '@atproto/api'

export const CHANNEL_LEXICON = 'dev.sia.pin.channel'
export const LEGACY_CHANNEL_LEXICON = 'dev.sia.dispatch.channel'
export const ALL_CHANNEL_LEXICONS = [
  CHANNEL_LEXICON,
  LEGACY_CHANNEL_LEXICON,
] as const

const DEFAULT_SERVICE = 'https://bsky.social'

export type ChannelRecord = {
  $type: typeof CHANNEL_LEXICON | typeof LEGACY_CHANNEL_LEXICON
  encryptedManifest: string // base64 of (1-byte version || 12-byte IV || AES-GCM ciphertext)
}

export type ATProtoSession = AtpSessionData

export async function signIn(
  identifier: string,
  password: string,
): Promise<{ session: ATProtoSession; agent: AtpAgent }> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  await agent.login({ identifier, password })
  if (!agent.session) {
    throw new Error('Login succeeded but no session returned')
  }
  return { session: agent.session, agent }
}

export async function resumeSession(
  session: ATProtoSession,
): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  await agent.resumeSession(session)
  return agent
}

export async function putChannelRecord(
  agent: AtpAgent,
  channelID: string,
  encryptedManifest: string,
): Promise<{ uri: string; cid: string }> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')
  const record: ChannelRecord = {
    $type: CHANNEL_LEXICON,
    encryptedManifest,
  }
  const result = await agent.com.atproto.repo.putRecord({
    repo: session.did,
    collection: CHANNEL_LEXICON,
    rkey: channelID,
    record,
    validate: false,
  })
  return { uri: result.data.uri, cid: result.data.cid }
}

// Read-both, prefer-new. Tries the current lexicon first; falls back to the
// legacy 'dev.sia.dispatch.channel' if the record isn't found in the new one.
// Lets pre-rename channels keep working without a forced migration.
export async function getChannelRecord(
  authorHandleOrDID: string,
  channelID: string,
): Promise<ChannelRecord> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  let lastErr: unknown
  for (const collection of ALL_CHANNEL_LEXICONS) {
    try {
      const result = await agent.com.atproto.repo.getRecord({
        repo: authorHandleOrDID,
        collection,
        rkey: channelID,
      })
      return result.data.value as ChannelRecord
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Channel record not found in any lexicon')
}

// Lists from both lexicons; deduplicates by rkey, preferring the record from
// the current lexicon when both exist.
export async function listChannelRecords(
  authorHandleOrDID: string,
): Promise<Array<{ rkey: string; record: ChannelRecord }>> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  const perCollection = await Promise.all(
    ALL_CHANNEL_LEXICONS.map(async (collection) => {
      try {
        const result = await agent.com.atproto.repo.listRecords({
          repo: authorHandleOrDID,
          collection,
        })
        return result.data.records.map((r) => {
          const rkey = r.uri.split('/').pop() ?? ''
          return { rkey, record: r.value as ChannelRecord }
        })
      } catch {
        return [] as Array<{ rkey: string; record: ChannelRecord }>
      }
    }),
  )
  const byRkey = new Map<string, { rkey: string; record: ChannelRecord }>()
  // ALL_CHANNEL_LEXICONS lists the current lexicon first, so the first
  // insert wins and legacy entries don't overwrite a present new one.
  for (const list of perCollection) {
    for (const entry of list) {
      if (!byRkey.has(entry.rkey)) byRkey.set(entry.rkey, entry)
    }
  }
  return [...byRkey.values()]
}

// Best-effort retract from both lexicons. Either may 404 (the record only
// existed in one collection) — treat that as success.
export async function deleteChannelRecord(
  agent: AtpAgent,
  channelID: string,
): Promise<void> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')
  await Promise.all(
    ALL_CHANNEL_LEXICONS.map(async (collection) => {
      try {
        await agent.com.atproto.repo.deleteRecord({
          repo: session.did,
          collection,
          rkey: channelID,
        })
      } catch {
        // Record didn't exist in this collection — fine.
      }
    }),
  )
}
