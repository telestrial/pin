import { describe, expect, it } from 'vitest'
import { buildSubscribeURL, parseSubscribeURL } from './channels'
import {
  channelKeyToBase64,
  deriveChannelID,
  generateChannelKey,
} from './crypto'

const DID = 'did:dht:iyypk375c71qwjem5isiramudutoogo1t9gogz8f587sfkt9db4o'

describe('subscribe URL (did:dht form)', () => {
  it('builds pin://<did:dht>#k=<K>', async () => {
    const k = channelKeyToBase64(await generateChannelKey())
    expect(buildSubscribeURL(DID, k)).toBe(`pin://${DID}#k=${k}`)
  })

  it('round-trips a did:dht URL: parse extracts didDht, empty handle, right K', async () => {
    const kBytes = await generateChannelKey()
    const k = channelKeyToBase64(kBytes)
    const parsed = await parseSubscribeURL(buildSubscribeURL(DID, k))
    expect(parsed.didDht).toBe(DID)
    expect(parsed.authorHandle).toBe('')
    expect(parsed.channelKey).toBe(k)
    expect(parsed.channelID).toBe(await deriveChannelID(kBytes))
  })

  it('still parses the legacy handle form (didDht undefined)', async () => {
    const k = channelKeyToBase64(await generateChannelKey())
    const parsed = await parseSubscribeURL(`pin://alice.bsky.social#k=${k}`)
    expect(parsed.authorHandle).toBe('alice.bsky.social')
    expect(parsed.didDht).toBeUndefined()
    expect(parsed.channelKey).toBe(k)
  })

  it('rejects a malformed URL', async () => {
    await expect(parseSubscribeURL('not-a-pin-url')).rejects.toThrow()
  })
})
