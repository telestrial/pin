// The row a reader actually sees: what an item's counts are, and what liking it does.
//
// Driven through the real component rather than the hook, because the things worth
// locking are things a hook test can't see — that a like reaches the doc as a signed
// record the fold would count, that a count read from the cache is the one rendered
// beside the right gesture, and that zero shows nothing rather than a "0".

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import {
  endorsement_verify,
  engagement_subject,
  tally_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
import { EngagementRow } from '../components/engagement/EngagementRow'
import type { ItemRef } from '../core/types'
import { fakeDocStore as docStore } from './fakeModules'
import {
  createFakeApp,
  FAKE_APP_KEY_HEX,
  mountAs,
  resetAllStores,
} from './setupFakeApp'

const CHANNEL_ID = 'chan1'
const PUBLISHED_AT = '2026-08-13T12:00:00.000Z'

const ITEM = {
  id: 'obj1',
  itemURL: 'sia://fake/obj1#k=obj1',
  type: 'text',
  title: '',
  summary: 'a post',
  publishedAt: PUBLISHED_AT,
  mimeType: 'text/markdown',
  byteSize: 6,
  contentHash: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq',
} as ItemRef

const INPUT = {
  item: ITEM,
  channel: { authorHandle: '', channelID: CHANNEL_ID, name: 'A channel' },
}

/** Put counts in the cache the way the Curator's loops would. */
function cacheCounts(kinds: Record<string, number>) {
  const subject = engagement_subject(CHANNEL_ID, PUBLISHED_AT, undefined)
  const aggregate = {
    kinds: Object.fromEntries(
      Object.entries(kinds).map(([kind, count]) => [
        kind,
        { count, setRoot: `root-${kind}`, sampleActors: [] },
      ]),
    ),
    updatedAt: PUBLISHED_AT,
  }
  docStore.set(
    `tally/${tally_rkey(CHANNEL_ID, subject)}`,
    new TextEncoder().encode(JSON.stringify(aggregate)),
  )
}

const likeRecords = () =>
  [...docStore.keys()].filter((k) => k.startsWith('endorse/like:'))

describe('integration: the engagement row', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
  })

  it('shows the counts its channel published, beside the gesture each belongs to', async () => {
    mountAs(
      createFakeApp().createAccount({
        did: 'did:plc:reader',
        handle: 'reader.test',
      }),
    )
    cacheCounts({ like: 4, pin: 2 })

    render(<EngagementRow input={INPUT} />)

    // Each count sits with its own gesture: a like count rendered against the pin would
    // be indistinguishable from a correct row at a glance, and wrong in the way that
    // matters most for a redundancy count.
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument())
    const likeCount = screen.getByText('4')
    const pinCount = screen.getByText('2')
    expect(likeCount.nextElementSibling).toHaveAttribute(
      'title',
      expect.stringMatching(/like/i),
    )
    expect(pinCount.nextElementSibling).toHaveAttribute(
      'title',
      expect.stringMatching(/pin|retract/i),
    )
  })

  it('shows nothing at all where there is no count', async () => {
    mountAs(
      createFakeApp().createAccount({
        did: 'did:plc:reader2',
        handle: 'reader2.test',
      }),
    )
    render(<EngagementRow input={INPUT} />)

    // Absent and zero are the same thing to a reader, and absent is much the more
    // common: most items are unendorsed, and an item whose counts no pass has read yet
    // reads identically. A literal "0" beside every post would be noise on all of them.
    await waitFor(() =>
      expect(screen.getByTitle(/^Like$/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('records a like as a signed record the fold would count', async () => {
    mountAs(
      createFakeApp().createAccount({
        did: 'did:plc:liker',
        handle: 'liker.test',
      }),
    )
    render(<EngagementRow input={INPUT} />)

    const heart = await screen.findByTitle(/^Like$/i)
    await userEvent.click(heart)

    await waitFor(() => expect(likeRecords()).toHaveLength(1))
    // Through the REAL verifier: a fake that accepted anything would let this pass
    // while every count in the network was forgeable.
    const record = new TextDecoder().decode(docStore.get(likeRecords()[0])!)
    expect(() => endorsement_verify(record)).not.toThrow()
    expect(JSON.parse(record).kind).toBe('like')
  })

  it('withdraws the record when the like is taken back', async () => {
    mountAs(
      createFakeApp().createAccount({
        did: 'did:plc:unliker',
        handle: 'unliker.test',
      }),
    )
    render(<EngagementRow input={INPUT} />)

    const heart = await screen.findByTitle(/^Like$/i)
    await userEvent.click(heart)
    await waitFor(() => expect(likeRecords()).toHaveLength(1))

    // The record has to GO, not sit at zero: a leftover is an over-count nothing else
    // would ever correct, since a fold counts what it holds.
    await userEvent.click(await screen.findByTitle(/remove your like/i))
    await waitFor(() => expect(likeRecords()).toHaveLength(0))
  })

  it('reflects a like made on another device', async () => {
    mountAs(
      createFakeApp().createAccount({
        did: 'did:plc:synced',
        handle: 'synced.test',
      }),
    )
    const { writeEndorsement } = await import('../lib/engagement')

    render(<EngagementRow input={INPUT} />)
    await screen.findByTitle(/^Like$/i)

    // What arriving over sync looks like from here: the record appears in the doc without
    // this tab having clicked anything, and the change feed is what tells the row.
    await writeEndorsement(
      FAKE_APP_KEY_HEX,
      'like',
      {
        channelID: CHANNEL_ID,
        publishedAt: PUBLISHED_AT,
        contentHash: ITEM.contentHash,
      },
      null,
    )
    await waitFor(() =>
      expect(screen.getByTitle(/remove your like/i)).toBeInTheDocument(),
    )
  })
})
