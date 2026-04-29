import { AtpAgent, type AtpSessionData } from '@atproto/api'

export const CHANNEL_LEXICON = 'dev.sia.dispatch.channel'
const DEFAULT_SERVICE = 'https://bsky.social'

export const ENCRYPTION_VERSION = 1

export type ChannelRecord = {
  $type: typeof CHANNEL_LEXICON
  channelHandle: string
  encryptedManifest: string    // base64 of (IV || AES-GCM ciphertext)
  encryptionVersion: typeof ENCRYPTION_VERSION
  updatedAt: string
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
  channelHandle: string,
  encryptedManifest: string,
): Promise<{ uri: string; cid: string }> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')
  const record: ChannelRecord = {
    $type: CHANNEL_LEXICON,
    channelHandle,
    encryptedManifest,
    encryptionVersion: ENCRYPTION_VERSION,
    updatedAt: new Date().toISOString(),
  }
  const result = await agent.com.atproto.repo.putRecord({
    repo: session.did,
    collection: CHANNEL_LEXICON,
    rkey: channelHandle,
    record,
    validate: false,
  })
  return { uri: result.data.uri, cid: result.data.cid }
}

export async function getChannelRecord(
  authorHandleOrDID: string,
  channelHandle: string,
): Promise<ChannelRecord> {
  const agent = new AtpAgent({ service: DEFAULT_SERVICE })
  const result = await agent.com.atproto.repo.getRecord({
    repo: authorHandleOrDID,
    collection: CHANNEL_LEXICON,
    rkey: channelHandle,
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
  channelHandle: string,
): Promise<void> {
  const session = agent.session
  if (!session) throw new Error('ATProto agent has no session')
  await agent.com.atproto.repo.deleteRecord({
    repo: session.did,
    collection: CHANNEL_LEXICON,
    rkey: channelHandle,
  })
}
