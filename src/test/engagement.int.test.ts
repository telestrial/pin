// Endorsements as doc records: the signed facts a count is later folded from.
//
// The properties worth locking are the ones that would fail quietly. A record has to
// VERIFY — through the real Rust verifier, not a fake one, because a fake that accepted
// anything would let this suite pass while every count in the network was forgeable. A
// like and a pin on one post have to be two records rather than one overwriting the
// other. An unlisted subject has to carry no reference, since that absence is the whole
// of its privacy. And a catch-up must never delete what it doesn't recognize.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import {
  endorsement_verify,
  engagement_subject,
} from '../../crates/pin-core/pkg/pin_core.js'
import {
  deleteEndorsement,
  type EndorsedItem,
  listEndorsementRkeys,
  syncEndorsements,
  writeEndorsement,
} from '../lib/engagement'
import { fakeDocStore as docStore } from './fakeModules'
import { FAKE_APP_KEY_HEX, resetAllStores } from './setupFakeApp'

const POST: EndorsedItem = {
  channelID: 'chan1',
  publishedAt: '2026-08-11T12:00:00.000Z',
  contentHash: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq',
}
const AUTHOR = 'did:dht:iyypk375c71qwjem5isiramudutoogo1t9gogz8f587sfkt9db4o'

const stored = (rkey: string) =>
  JSON.parse(new TextDecoder().decode(docStore.get(`endorse/${rkey}`)!))
const rkeys = () =>
  [...docStore.keys()]
    .filter((k) => k.startsWith('endorse/'))
    .map((k) => k.slice('endorse/'.length))
    .sort()

describe('integration: endorsements are recorded in the doc', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('writes a record that verifies against the identity that signed it', async () => {
    await writeEndorsement(FAKE_APP_KEY_HEX, 'like', POST, null)
    const record = stored(rkeys()[0])

    // Through the real verifier. A count is only worth anything if a forgery fails here,
    // so the check this suite makes has to be the one the Curator's fold makes.
    expect(() => endorsement_verify(JSON.stringify(record))).not.toThrow()
    expect(record.kind).toBe('like')
    expect(record.subject).toBe(
      engagement_subject(POST.channelID, POST.publishedAt),
    )
    expect(record.version).toBe(POST.contentHash)
    expect(record.actor).toMatch(/^did:dht:/)
  })

  it('rejects a record whose signed fields were altered', async () => {
    await writeEndorsement(FAKE_APP_KEY_HEX, 'like', POST, null)
    const record = stored(rkeys()[0])

    // Paired with the test above on purpose: a verifier that always threw would satisfy
    // this one alone, and a verifier that never threw would satisfy that one alone.
    record.subject = engagement_subject('chan1', '2026-08-11T13:00:00.000Z')
    expect(() => endorsement_verify(JSON.stringify(record))).toThrow()
  })

  it('keeps a like and a pin on one post as two records', async () => {
    // Both gestures are available on the same post, which is why the kind is in the
    // address. Keying on the subject alone would silently make one replace the other.
    await writeEndorsement(FAKE_APP_KEY_HEX, 'like', POST, null)
    await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', POST, null)

    const subject = engagement_subject(POST.channelID, POST.publishedAt)
    expect(rkeys()).toEqual([`like:${subject}`, `pin:${subject}`])
  })

  it('names the author only when a reference is asked for', async () => {
    await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', POST, AUTHOR)
    const withRef = stored(rkeys()[0])
    expect(withRef.ref).toEqual({
      didDht: AUTHOR,
      channelID: POST.channelID,
      publishedAt: POST.publishedAt,
    })
    // The reference has to hash to the subject it claims, or it is ignored — which is
    // what makes it safe to carry outside the signature.
    expect(() => endorsement_verify(JSON.stringify(withRef))).not.toThrow()

    docStore.clear()
    await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', POST, null)
    const bare = stored(rkeys()[0])
    // An unlisted subject's record is a countable token and nothing else. This absence
    // is the privacy: no channel named, no evidence the channel exists.
    expect(bare.ref).toBeUndefined()
    expect(JSON.stringify(bare)).not.toContain(POST.channelID)
    expect(() => endorsement_verify(JSON.stringify(bare))).not.toThrow()
  })

  it('does not rewrite an unchanged record, so re-endorsing costs nothing', async () => {
    expect(await writeEndorsement(FAKE_APP_KEY_HEX, 'like', POST, null)).toBe(
      true,
    )
    const first = stored(rkeys()[0])

    expect(await writeEndorsement(FAKE_APP_KEY_HEX, 'like', POST, null)).toBe(
      false,
    )
    // Same signature and same timestamp: the endorsement was made when it was made, and
    // a rewrite would both churn the doc and move the moment it claims.
    expect(stored(rkeys()[0])).toEqual(first)
  })

  it('upgrades a bare record to a referenced one without re-signing it', async () => {
    // The case a catch-up hits: the record was first written before the channel's
    // manifest had loaded, so nothing was known to reference. The reference sits outside
    // the signature precisely so it can be added later.
    await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', POST, null)
    const bare = stored(rkeys()[0])

    expect(await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', POST, AUTHOR)).toBe(
      true,
    )
    const upgraded = stored(rkeys()[0])
    expect(upgraded.ref.didDht).toBe(AUTHOR)
    expect(upgraded.sig).toBe(bare.sig)
    expect(() => endorsement_verify(JSON.stringify(upgraded))).not.toThrow()
  })

  it('rewrites a record whose version moved', async () => {
    await writeEndorsement(FAKE_APP_KEY_HEX, 'like', POST, null)
    const before = stored(rkeys()[0])

    const edited = { ...POST, contentHash: 'bafkreidifferentversion' }
    expect(await writeEndorsement(FAKE_APP_KEY_HEX, 'like', edited, null)).toBe(
      true,
    )
    const after = stored(rkeys()[0])
    // Same record — the subject survives an edit deliberately — carrying the version it
    // is now made against.
    expect(rkeys()).toHaveLength(1)
    expect(after.version).toBe('bafkreidifferentversion')
    expect(after.sig).not.toBe(before.sig)
  })

  it('withdraws a record and leaves the other kind alone', async () => {
    await writeEndorsement(FAKE_APP_KEY_HEX, 'like', POST, null)
    await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', POST, null)

    await deleteEndorsement(FAKE_APP_KEY_HEX, 'like', POST)
    const subject = engagement_subject(POST.channelID, POST.publishedAt)
    expect(rkeys()).toEqual([`pin:${subject}`])
  })

  it('gives an attachment its own subject, distinct from its post’s', async () => {
    // Keeping one file alive is not keeping the post alive, so the file gets its own
    // figure. If these collided, a partial custodian would be counted as a full one and
    // the post's redundancy number would be an overstatement.
    const attachment = 'bafkreitheattachment'
    await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', POST, null)
    await writeEndorsement(
      FAKE_APP_KEY_HEX,
      'pin',
      { ...POST, contentHash: attachment, attachment },
      null,
    )

    const postSubject = engagement_subject(POST.channelID, POST.publishedAt)
    const fileSubject = engagement_subject(
      POST.channelID,
      POST.publishedAt,
      attachment,
    )
    expect(fileSubject).not.toBe(postSubject)
    expect(rkeys()).toEqual([`pin:${postSubject}`, `pin:${fileSubject}`].sort())
  })

  it('checks an attachment reference against the attachment subject', async () => {
    const attachment = 'bafkreitheattachment'
    await writeEndorsement(
      FAKE_APP_KEY_HEX,
      'pin',
      { ...POST, contentHash: attachment, attachment },
      AUTHOR,
    )
    const held = stored(rkeys()[0])
    expect(held.ref.attachment).toBe(attachment)
    expect(() => endorsement_verify(JSON.stringify(held))).not.toThrow()

    // Dropping the field would reinterpret a file's endorsement as the whole post's.
    const asPost = { ...held, ref: { ...held.ref, attachment: undefined } }
    expect(() => endorsement_verify(JSON.stringify(asPost))).toThrow()
  })

  it('does not rewrite a hash-only attachment record on every pass', async () => {
    // The trap: with no reference there is no field to hold the attachment, so comparing
    // one unconditionally reports a difference forever — and every catch-up would rewrite
    // the record and announce a change to every instance syncing the doc.
    const attachment = 'bafkreitheattachment'
    const item = { ...POST, contentHash: attachment, attachment }
    expect(await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', item, null)).toBe(
      true,
    )
    expect(await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', item, null)).toBe(
      false,
    )
    expect(
      await syncEndorsements(FAKE_APP_KEY_HEX, [
        { kind: 'pin', item, referenceAuthor: null },
      ]),
    ).toEqual({ written: 0 })
  })

  it('catches up what is missing and never removes what it does not recognize', async () => {
    // A record from another of this identity's devices, which this pass knows nothing
    // about. Deleting it would be deletion by absence — the mistake already made twice
    // here, in the orphan sweep and in settings — and two devices share this doc.
    const other = {
      channelID: 'chan9',
      publishedAt: '2026-01-01T00:00:00.000Z',
    }
    await writeEndorsement(FAKE_APP_KEY_HEX, 'pin', other, null)

    const { written } = await syncEndorsements(FAKE_APP_KEY_HEX, [
      { kind: 'pin', item: POST, referenceAuthor: AUTHOR },
      { kind: 'pin', item: other, referenceAuthor: null },
    ])

    expect(written).toBe(1) // only the one that was missing
    expect(await listEndorsementRkeys(FAKE_APP_KEY_HEX)).toHaveLength(2)
  })
})
