// Writing a comment, from the intent side.
//
// One local doc write and nothing else — no Sia, no network. What these cover is the part
// the frontend owns: that the record is signed, that it lands where the Curator will look
// for it, that saying two things is two records, and that taking one back is a delete.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/channelLocatorNative', async () =>
  (await import('./fakeModules')).fakeChannelLocatorNativeModule(),
)
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { tallySubject } from '../lib/channelTallies'
import {
  bodyBytes,
  holdsComment,
  maxCommentBytes,
  pinInputForComment,
  withdrawComment,
  writeComment,
} from '../lib/comments'
import { getRecord, listRecords } from '../lib/docs'
import { endorsementRkey } from '../lib/engagement'
import { endorsedItemFor } from '../stores/pin'
import { fakeDocStore as docStore } from './fakeModules'
import { FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

const ITEM = {
  channelID: 'chan-one',
  publishedAt: '2026-08-22T10:00:00.000Z',
  contentHash: 'bafkreiabc',
}

async function held() {
  const { comment_collection } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  return listRecords(comment_collection())
}

async function sealMarks() {
  const { comment_seal_collection } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  return listRecords(comment_seal_collection())
}

async function sealMark(rkey: string) {
  const { comment_seal_collection } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  const raw = await getRecord(comment_seal_collection(), rkey)
  return raw
    ? (JSON.parse(new TextDecoder().decode(raw)) as { channelID: string })
    : null
}

/** Put a manifest in the store, which is where the visibility a seal turns on is read from. */
async function knownChannel(visibility: 'public' | 'obscure' | undefined) {
  const { useFeedStore } = await import('../stores/feed')
  useFeedStore.getState().setManifest(ITEM.channelID, {
    channelID: ITEM.channelID,
    name: 'a channel',
    items: [],
    publishedAt: ITEM.publishedAt,
    visibility,
  } as never)
}

function decode(bytes: Uint8Array) {
  return JSON.parse(new TextDecoder().decode(bytes)) as {
    kind: string
    actor: string
    subject: string
    body: string
    createdAt: string
    sig: string
    ref?: unknown
  }
}

describe('integration: writing a comment', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('signs the words and stores them where the Curator looks', async () => {
    const id = await writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'worth saying')

    const rkeys = await held()
    expect(rkeys).toHaveLength(1)
    // Addressed by the subject then the comment's own id — the address the Curator's
    // publisher and its deliver loop both derive. A mismatch here would be a comment
    // nothing ever picks up.
    expect(rkeys[0].endsWith(`:${id}`)).toBe(true)

    const record = decode((await getStored(rkeys[0])) as Uint8Array)
    expect(record.kind).toBe('comment')
    expect(record.body).toBe('worth saying')
    expect(record.actor.startsWith('did:dht:')).toBe(true)
    expect(record.sig).not.toBe('')
  })

  it('says two things as two records', async () => {
    // A gesture is a singleton at its address, so re-making one rewrites it. Saying
    // something twice is two things said, and the singleton is what a comment breaks.
    const first = await writeComment(
      FAKE_APP_KEY_HEX,
      ITEM,
      null,
      'first',
      '2026-08-22T12:00:00.000Z',
    )
    const second = await writeComment(
      FAKE_APP_KEY_HEX,
      ITEM,
      null,
      'second',
      '2026-08-22T13:00:00.000Z',
    )
    expect(first).not.toBe(second)
    expect(await held()).toHaveLength(2)
  })

  it('keeps the subject hash alone when no author is named', async () => {
    // The safe tier: a reference makes the record navigable and is correct only for a
    // public channel. Passing nothing must publish no coordinates at all.
    await writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'quietly')
    const rkeys = await held()
    expect(
      decode((await getStored(rkeys[0])) as Uint8Array).ref,
    ).toBeUndefined()
  })

  it('carries the author’s coordinates when one is named', async () => {
    await writeComment(FAKE_APP_KEY_HEX, ITEM, 'did:dht:author', 'openly')
    const rkeys = await held()
    const record = decode((await getStored(rkeys[0])) as Uint8Array)
    expect(record.ref).toEqual({
      didDht: 'did:dht:author',
      channelID: ITEM.channelID,
      publishedAt: ITEM.publishedAt,
    })
  })

  it('refuses a body over the limit rather than signing one nobody would take', async () => {
    // The host refuses it on arrival, so signing it is work nobody can use.
    const max = await maxCommentBytes()
    await expect(
      writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'x'.repeat(max + 1)),
    ).rejects.toThrow()
    expect(await held()).toHaveLength(0)

    // And exactly at the limit is fine.
    await writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'x'.repeat(max))
    expect(await held()).toHaveLength(1)
  })

  it('counts a body in bytes, not characters', async () => {
    // A composer counting characters would let through four times the bytes the receiver
    // allows, and the refusal would land at the signature instead of in the form.
    expect(bodyBytes('abc')).toBe(3)
    expect(bodyBytes('é')).toBe(2)
    expect(bodyBytes('😀')).toBe(4)
  })

  it('marks a comment on a channel that is not public to be sealed', async () => {
    // The blob the Curator publishes these into hangs off the directory and is
    // world-readable, so an unlisted post's conversation has to go in sealed. The mark is
    // how the composer, which knows the channel's visibility, tells the publish loop, which
    // knows how to seal.
    await knownChannel('obscure')
    await writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'between us')

    // The same address the record itself is at, so the loop reading one finds the other.
    const rkeys = await held()
    expect(await sealMarks()).toEqual(rkeys)
    expect(await sealMark(rkeys[0])).toEqual({ channelID: ITEM.channelID })
  })

  it('leaves a comment on a public channel in the clear', async () => {
    // Not an oversight and not the safe-by-default direction: a public post's count is only
    // auditable by somebody holding no key if the records behind it are readable by them.
    await knownChannel('public')
    await writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'said openly')
    expect(await sealMarks()).toHaveLength(0)
  })

  it('seals when the channel says nothing about being public', async () => {
    // Two ways to know nothing, and both take the safe direction: a manifest with no
    // visibility field, which every reader here treats as obscure, and one that never
    // loaded. Being sealed costs a keyless reader nothing they were promised; being in the
    // clear cannot be taken back.
    await knownChannel(undefined)
    await writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'unsure')
    expect(await sealMarks()).toHaveLength(1)

    docStore.clear()
    resetAllStores()
    await writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'unknown channel')
    expect(await sealMarks()).toHaveLength(1)
  })

  it('takes the mark back with the comment', async () => {
    // Or the next pass would look for a comment to seal that nobody holds any more.
    await knownChannel('obscure')
    const id = await writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'regretted')
    expect(await sealMarks()).toHaveLength(1)

    await withdrawComment(FAKE_APP_KEY_HEX, ITEM, id)
    expect(await sealMarks()).toHaveLength(0)
  })

  it('takes a comment back by deleting the record', async () => {
    const id = await writeComment(FAKE_APP_KEY_HEX, ITEM, null, 'regretted')
    expect(await holdsComment(ITEM, id)).toBe(true)

    await withdrawComment(FAKE_APP_KEY_HEX, ITEM, id)
    expect(await holdsComment(ITEM, id)).toBe(false)
    expect(await held()).toHaveLength(0)
  })

  it('leaves the others alone when one is taken back', async () => {
    const first = await writeComment(
      FAKE_APP_KEY_HEX,
      ITEM,
      null,
      'kept',
      '2026-08-22T12:00:00.000Z',
    )
    const second = await writeComment(
      FAKE_APP_KEY_HEX,
      ITEM,
      null,
      'withdrawn',
      '2026-08-22T13:00:00.000Z',
    )
    await withdrawComment(FAKE_APP_KEY_HEX, ITEM, second)

    expect(await holdsComment(ITEM, first)).toBe(true)
    expect(await holdsComment(ITEM, second)).toBe(false)
  })
})

async function getStored(rkey: string) {
  const { comment_collection } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  const { getRecord } = await import('../lib/docs')
  return getRecord(comment_collection(), rkey)
}

describe('integration: keeping a comment', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  const POST = { channelID: 'chan-one', publishedAt: ITEM.publishedAt }
  const SAID = {
    kind: 'comment',
    actor: 'did:dht:bob',
    subject: 'sub',
    version: 'bafkreiabc',
    createdAt: '2026-08-22T12:00:00.000Z',
    sig: 'AAAA',
    body: 'worth keeping',
  }

  it('offers nothing to keep until the author has minted the object', async () => {
    // A comment reads fine without one and offers no custody: there is nothing to take
    // custody OF until there is an address, and the words alone live in blobs that are
    // superseded on every write.
    expect(pinInputForComment(SAID, POST)).toBeNull()
  })

  it('keeps a comment as a library pin whose origin names it', async () => {
    const input = pinInputForComment(
      { ...SAID, bodyURL: 'sia://body#encryption_key=k' },
      POST,
    )
    expect(input?.channel.channelID).toBe('library')
    expect(input?.item.itemURL).toBe('sia://body#encryption_key=k')
    // The comment's own time, so a kept comment sorts where it was said.
    expect(input?.item.publishedAt).toBe(SAID.createdAt)
    // What makes it more than loose bytes: the post locates the channel doc its counts
    // live in, and the actor and time say which comment they are about.
    expect(input?.origin).toEqual({
      channelID: POST.channelID,
      publishedAt: POST.publishedAt,
      commentActor: SAID.actor,
      commentCreatedAt: SAID.createdAt,
    })
  })

  it('reports a kept comment’s subject as the comment’s own', async () => {
    // Not the post's. A pin on a comment counts toward the comment, and the two subjects
    // come from different derivations entirely.
    const input = pinInputForComment(
      { ...SAID, bodyURL: 'sia://body#encryption_key=k' },
      POST,
    )
    const endorsed = endorsedItemFor({
      ...(input as NonNullable<typeof input>),
      objectID: 'obj1',
      attachmentObjectIDs: [],
      pinnedAt: SAID.createdAt,
    })
    expect(endorsed?.comment).toEqual({
      actor: SAID.actor,
      createdAt: SAID.createdAt,
    })
    expect(await tallySubject(endorsed as NonNullable<typeof endorsed>)).toBe(
      await commentSubjectOf(SAID.actor, SAID.createdAt),
    )
  })

  it('addresses an endorsement of a comment away from the post’s', async () => {
    // Same kind, same keyspace, different subject — so keeping a comment and keeping the
    // post it sits under are two records rather than one overwriting the other.
    const onComment = await endorsementRkey('pin', {
      channelID: POST.channelID,
      publishedAt: POST.publishedAt,
      comment: { actor: SAID.actor, createdAt: SAID.createdAt },
    })
    const onPost = await endorsementRkey('pin', POST)
    expect(onComment).not.toBe(onPost)
    expect(onComment.startsWith('pin:')).toBe(true)
  })
})

async function commentSubjectOf(actor: string, createdAt: string) {
  const { comment_subject } = await import(
    '../../crates/pin-core/pkg/pin_core.js'
  )
  return comment_subject(actor, createdAt)
}
