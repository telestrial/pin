// A comment as a resumable action.
//
// Every other action in the journal is idempotent because the thing it writes is a
// singleton at its address: re-running a publish edits the same item, re-running a
// gesture rewrites the same record. A comment is not — saying something twice is two
// things said — so re-running it is only safe because the address is frozen at enqueue.
// A comment's id is f(actor, createdAt), and a handler that stamped its own would post
// the comment again on every resume.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { comment_collection } from '../../crates/pin-core/pkg/pin_core.js'
import { runComment } from '../lib/actions/comment'
import { listRecords } from '../lib/docs'
import type { CommentAction } from '../stores/actionQueue'
import { fakeDocStore as docStore } from './fakeModules'
import type { FakeSiaClient } from './fakeSia'
import { createFakeApp, FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

const SUBJECT = {
  channelID: 'chan1',
  publishedAt: '2026-08-22T12:00:00.000Z',
  contentHash: 'bafkreiabc',
}
const WRITTEN_AT = '2026-09-20T12:00:00.000Z'
const FILE = new Uint8Array([9, 9, 9])

function action(over: Partial<CommentAction> = {}): CommentAction {
  return {
    id: 'act-1',
    kind: 'comment',
    state: 'running',
    progress: 0,
    createdAt: WRITTEN_AT,
    title: 'worth saying',
    successLabel: 'Added',
    failLabel: 'Add',
    intent: {
      subject: SUBJECT,
      referenceAuthor: null,
      body: 'worth saying',
      facets: [],
      sources: [],
      referenced: [],
      createdAt: WRITTEN_AT,
    },
    ledger: {},
    ...over,
  } as CommentAction
}

describe('integration: a comment through the journal', () => {
  let client: FakeSiaClient
  let checkpoints: number

  const ctx = (a: CommentAction) => ({
    client,
    appKeyHex: FAKE_APP_KEY_HEX,
    setPhase: () => {},
    setProgress: () => {},
    checkpoint: (carried: NonNullable<CommentAction['ledger']['carried']>) => {
      checkpoints += 1
      a.ledger = { uploaded: true, carried }
    },
  })

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    checkpoints = 0
    client = createFakeApp().createAccount({
      did: 'did:plc:alice',
      handle: 'alice.test',
    }).client
  })

  it('writes one comment however many times it runs', async () => {
    // The resume case. A crash between the record write and the journal marking the
    // action done re-runs it, and the address is what decides whether that is the same
    // comment or a second one.
    const a = action()
    await runComment(a, ctx(a))
    await runComment(a, ctx(a))

    expect(await listRecords(comment_collection())).toHaveLength(1)
  })

  it('writes a second comment when the stamp moves', async () => {
    // The other half, or the guard above is satisfied by a handler that writes nothing
    // the second time for some unrelated reason.
    const first = action()
    await runComment(first, ctx(first))
    const second = action({
      id: 'act-2',
      intent: { ...action().intent, createdAt: '2026-09-20T12:05:00.000Z' },
    })
    await runComment(second, ctx(second))

    expect(await listRecords(comment_collection())).toHaveLength(2)
  })

  it('checkpoints the carried files before the record names them', async () => {
    const a = action({
      intent: {
        ...action().intent,
        sources: [{ bytes: FILE, mimeType: 'image/png', filename: 'a.png' }],
      },
    })

    await runComment(a, ctx(a))

    expect(checkpoints).toBe(1)
    expect(a.ledger.carried).toHaveLength(1)
    // The object id rides beside the attachment, being what gives the bytes back.
    expect(a.ledger.carried?.[0].objectID).toBeTruthy()
  })

  it('skips the upload on a resume that carries a checkpoint', async () => {
    // The bytes are still on the action — only the persisted copy drops them — so the
    // checkpoint has to be what decides, or a retry mints a second object nothing will
    // reclaim.
    const packed = vi.spyOn(client, 'uploadItemsPacked')
    const a = action({
      intent: {
        ...action().intent,
        sources: [{ bytes: FILE, mimeType: 'image/png', filename: 'a.png' }],
      },
      ledger: {
        uploaded: true,
        carried: [
          {
            attachment: {
              url: 'sia://kept#encryption_key=aa',
              mimeType: 'image/png',
              filename: 'a.png',
              byteSize: 3,
              contentHash: 'bafkreikept',
            },
            objectID: 'obj-kept',
          },
        ],
      },
    })

    await runComment(a, ctx(a))

    expect(packed).not.toHaveBeenCalled()
    const rkeys = await listRecords(comment_collection())
    const raw = docStore.get(`${comment_collection()}/${rkeys[0]}`)
    const record = JSON.parse(new TextDecoder().decode(raw as Uint8Array))
    expect(record.attachments[0].url).toBe('sia://kept#encryption_key=aa')
  })

  it('writes nothing when the upload fails', async () => {
    // Bytes first: a record must never name files that did not land.
    vi.spyOn(client, 'uploadItemsPacked').mockRejectedValue(
      new Error('host down'),
    )
    const a = action({
      intent: {
        ...action().intent,
        sources: [{ bytes: FILE, mimeType: 'image/png', filename: 'a.png' }],
      },
    })

    await expect(runComment(a, ctx(a))).rejects.toThrow('host down')
    expect(await listRecords(comment_collection())).toHaveLength(0)
  })
})
