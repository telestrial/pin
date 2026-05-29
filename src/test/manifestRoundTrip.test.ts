// Sanity test for the Phase 3 fakes: a manifest written by Alice as
// AES-GCM ciphertext under her channel key K can be fetched by Bob from
// Alice's repo, decrypted with the same K, and re-parsed.
//
// This is the architectural promise Pin is built on — ATProto stores
// ciphertext, K stays in the URL fragment — exercised end-to-end against
// the fake substrate without core/channels.ts. (core/channels.ts pulls
// in unauthenticated AtpAgent reads which need module-mocking; that's
// Phase 4's concern.)

import { describe, expect, it } from 'vitest'
import { CHANNEL_LEXICON } from '../core/atproto'
import {
  decryptForChannel,
  deriveChannelID,
  encryptForChannel,
  generateChannelKey,
} from '../core/crypto'
import { CHANNEL_MANIFEST_VERSION, type ChannelManifest } from '../core/types'
import { FakeAgent } from './fakeAgent'
import { createFakeWorld } from './fakeSdk'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

describe('manifest round-trip through fake ATProto + AES-GCM', () => {
  it("Alice writes; Bob reads from Alice's repo and decrypts with the shared K", async () => {
    const world = createFakeWorld()
    const alice = new FakeAgent(ALICE, world)
    const bob = new FakeAgent(BOB, world)

    const keyBytes = await generateChannelKey()
    const channelID = await deriveChannelID(keyBytes)

    const manifest: ChannelManifest = {
      version: CHANNEL_MANIFEST_VERSION,
      name: "Alice's voice",
      description: 'Things worth keeping',
      authorPubkey: 'appkey-alice',
      authorATProtoDID: ALICE,
      publishedAt: '2026-05-29T10:00:00.000Z',
      items: [
        {
          id: 'item-1',
          itemURL: 'sia://fake/0001#k=0001',
          type: 'text',
          title: '',
          summary: 'A short post',
          publishedAt: '2026-05-29T09:00:00.000Z',
          mimeType: 'text/markdown',
          byteSize: 12,
          contentHash: 'bafkreitest',
        },
      ],
    }

    // Alice publishes: encrypt + write to her own repo at the derived rkey.
    const ciphertext = await encryptForChannel(keyBytes, JSON.stringify(manifest))
    await alice.com.atproto.repo.putRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: channelID,
      record: { $type: CHANNEL_LEXICON, encryptedManifest: ciphertext },
    })

    // Bob (with K, shared out-of-band via the subscribe URL): read +
    // decrypt + parse. No K, no manifest — that's the architectural promise.
    const got = await bob.com.atproto.repo.getRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: channelID,
    })
    const record = got.data.value as {
      $type: string
      encryptedManifest: string
    }
    expect(record.$type).toBe(CHANNEL_LEXICON)

    const plaintext = await decryptForChannel(keyBytes, record.encryptedManifest)
    const parsed = JSON.parse(plaintext) as ChannelManifest

    expect(parsed).toEqual(manifest)
    expect(parsed.items[0].itemURL).toBe('sia://fake/0001#k=0001')
  })

  it("Bob cannot decrypt without K (the record body looks like opaque base64)", async () => {
    const world = createFakeWorld()
    const alice = new FakeAgent(ALICE, world)
    const bob = new FakeAgent(BOB, world)

    const aliceKey = await generateChannelKey()
    const channelID = await deriveChannelID(aliceKey)
    const wrongKey = await generateChannelKey()

    const ciphertext = await encryptForChannel(
      aliceKey,
      JSON.stringify({ secret: 'do not read' }),
    )
    await alice.com.atproto.repo.putRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: channelID,
      record: { $type: CHANNEL_LEXICON, encryptedManifest: ciphertext },
    })

    const got = await bob.com.atproto.repo.getRecord({
      repo: ALICE,
      collection: CHANNEL_LEXICON,
      rkey: channelID,
    })
    const record = got.data.value as { encryptedManifest: string }

    // Bob can read the ciphertext — it's a public record — but without K
    // he can't get the plaintext. AES-GCM auth-tag verification fails.
    await expect(
      decryptForChannel(wrongKey, record.encryptedManifest),
    ).rejects.toThrow()
  })
})
