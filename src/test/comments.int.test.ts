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

import {
  bodyBytes,
  holdsComment,
  maxCommentBytes,
  withdrawComment,
  writeComment,
} from '../lib/comments'
import { listRecords } from '../lib/docs'
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
