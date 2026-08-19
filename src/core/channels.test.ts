import { describe, expect, it } from 'vitest'
import {
  buildSubscribeURL,
  parseSubscribeURL,
  removeRepostFromChannel,
  repostToChannel,
} from './channels'
import {
  channelKeyToBase64,
  deriveChannelID,
  generateChannelKey,
} from './crypto'
import { CHANNEL_MANIFEST_VERSION, type ChannelManifest } from './types'

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

// The transforms themselves are proven in pin-manifest, against vectors captured from
// the implementation they replaced. What can only be checked from this side is the
// CROSSING: a portal is built here as an object and read back here as an object, with
// Rust in between, and a field whose name disagreed across that boundary would be
// invisible to both compilers.

const SOURCE = 'did:dht:sourceauthor'

function emptyChannel(): ChannelManifest {
  return {
    version: CHANNEL_MANIFEST_VERSION,
    name: 'Mine',
    description: '',
    authorPubkey: 'ed25519:aa',
    publishedAt: '2026-07-01T09:00:00.000Z',
    items: [],
  }
}

describe('reposting through the wasm transforms', () => {
  it('carries every field of a portal across the boundary', async () => {
    const after = await repostToChannel(emptyChannel(), {
      didDht: SOURCE,
      channelID: 'srcchan',
      publishedAt: '2026-08-01T10:00:00.000Z',
      repostedAt: '2026-08-02T10:00:00.000Z',
      cachedName: 'Their channel',
    })

    expect(after.reposts).toEqual([
      {
        didDht: SOURCE,
        channelID: 'srcchan',
        publishedAt: '2026-08-01T10:00:00.000Z',
        repostedAt: '2026-08-02T10:00:00.000Z',
        cachedName: 'Their channel',
      },
    ])
  })

  it('leaves a channel that reposted nothing without the field', async () => {
    // Absent rather than [] — a manifest is compared for change by stringify-equality.
    const after = await removeRepostFromChannel(emptyChannel(), {
      didDht: SOURCE,
      channelID: 'srcchan',
      publishedAt: '2026-08-01T10:00:00.000Z',
    })
    expect('reposts' in after).toBe(false)
  })

  it('adds and removes one portal without disturbing another', async () => {
    const target = {
      didDht: SOURCE,
      channelID: 'srcchan',
      publishedAt: '2026-08-01T10:00:00.000Z',
    }
    const one = await repostToChannel(emptyChannel(), {
      ...target,
      repostedAt: '2026-08-02T10:00:00.000Z',
    })
    const two = await repostToChannel(one, {
      ...target,
      publishedAt: '2026-08-03T10:00:00.000Z',
      repostedAt: '2026-08-03T11:00:00.000Z',
    })
    expect(two.reposts).toHaveLength(2)

    const after = await removeRepostFromChannel(two, target)
    expect(after.reposts).toHaveLength(1)
    expect(after.reposts?.[0].publishedAt).toBe('2026-08-03T10:00:00.000Z')
  })

  it('does not put a portal among the items', async () => {
    // A portal is a sibling of `items`, not a member of it.
    const after = await repostToChannel(emptyChannel(), {
      didDht: SOURCE,
      channelID: 'srcchan',
      publishedAt: '2026-08-01T10:00:00.000Z',
      repostedAt: '2026-08-02T10:00:00.000Z',
    })
    expect(after.items).toEqual([])
  })
})
