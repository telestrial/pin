import { Agent, AtpAgent } from '@atproto/api'

export const CHANNEL_LEXICON = 'dev.sia.pin.channel'

const DEFAULT_SERVICE = 'https://bsky.social'

export type ChannelRecord = {
  $type: typeof CHANNEL_LEXICON
  encryptedManifest: string // base64 of (1-byte version || 12-byte IV || AES-GCM ciphertext)
}

// The authenticated agent is now constructed by the caller from an OAuthSession.
// This module just consumes it.
export async function putChannelRecord(
  agent: Agent,
  channelID: string,
  encryptedManifest: string,
): Promise<{ uri: string; cid: string }> {
  const did = agent.assertDid
  const record: ChannelRecord = {
    $type: CHANNEL_LEXICON,
    encryptedManifest,
  }
  const result = await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: CHANNEL_LEXICON,
    rkey: channelID,
    record,
    validate: false,
  })
  return { uri: result.data.uri, cid: result.data.cid }
}

// Unauthenticated reads — uses a bare AtpAgent against bsky.social since this
// path doesn't require user auth.
export async function getChannelRecord(
  authorHandleOrDID: string,
  channelID: string,
): Promise<ChannelRecord> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  const result = await agent.com.atproto.repo.getRecord({
    repo: authorHandleOrDID,
    collection: CHANNEL_LEXICON,
    rkey: channelID,
  })
  return result.data.value as ChannelRecord
}

export async function listChannelRecords(
  authorHandleOrDID: string,
): Promise<Array<{ rkey: string; record: ChannelRecord }>> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  const result = await agent.com.atproto.repo.listRecords({
    repo: authorHandleOrDID,
    collection: CHANNEL_LEXICON,
  })
  return result.data.records.map((r) => {
    const rkey = r.uri.split('/').pop() ?? ''
    return { rkey, record: r.value as ChannelRecord }
  })
}

export async function deleteChannelRecord(
  agent: Agent,
  channelID: string,
): Promise<void> {
  const did = agent.assertDid
  await agent.com.atproto.repo.deleteRecord({
    repo: did,
    collection: CHANNEL_LEXICON,
    rkey: channelID,
  })
}
