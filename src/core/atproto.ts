import { AtpAgent, type AtpSessionData } from '@atproto/api'

export const CHANNEL_LEXICON = 'dev.sia.dispatch.channel'
const DEFAULT_SERVICE = 'https://bsky.social'

export type ChannelRecord = {
  $type: typeof CHANNEL_LEXICON
  encryptedManifest: string    // base64 of (1-byte version || 12-byte IV || AES-GCM ciphertext)
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
  agent: AtpAgent,
  channelID: string,
): Promise<void> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')
  await agent.com.atproto.repo.deleteRecord({
    repo: session.did,
    collection: CHANNEL_LEXICON,
    rkey: channelID,
  })
}
