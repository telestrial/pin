// The conversation a reader actually sees, and what saying something does.
//
// Driven through the component rather than the hooks, because the things worth locking are
// things a hook test can't see: that a channel which never turned comments on offers none
// at all, that what renders is what the AUTHOR published rather than what this identity
// wrote, and that a comment lands in the doc as a signed record the fold would take.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import {
  comment_collection,
  endorsement_verify,
  engagement_subject,
  thread_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
import { CommentThread } from '../components/engagement/CommentThread'
import type { ChannelManifest } from '../core/types'
import { listRecords } from '../lib/docs'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const CHANNEL_ID = 'chan1'
const PUBLISHED_AT = '2026-08-22T12:00:00.000Z'
const ITEM = {
  channelID: CHANNEL_ID,
  publishedAt: PUBLISHED_AT,
  contentHash: 'bafkreiabc',
}

/** A manifest in the feed store, which is where the component reads whether this channel
 *  takes comments at all. */
function manifestSays(comments: boolean | undefined) {
  useFeedStore.setState({
    manifests: {
      [CHANNEL_ID]: {
        version: 1,
        name: 'A channel',
        description: '',
        authorPubkey: 'ed25519:aa',
        authorDidDht: 'did:dht:author',
        publishedAt: PUBLISHED_AT,
        visibility: 'public',
        comments,
        items: [],
      } as ChannelManifest,
    },
  })
}

/** Put a conversation in the cache the way the Curator's loops would. */
function published(bodies: { actor: string; body: string }[]) {
  const subject = engagement_subject(CHANNEL_ID, PUBLISHED_AT, undefined)
  docStore.set(
    `thread/${thread_rkey(CHANNEL_ID, subject)}`,
    new TextEncoder().encode(
      JSON.stringify({
        comments: bodies.map((b, i) => ({
          kind: 'comment',
          actor: b.actor,
          subject,
          version: 'bafkreiabc',
          createdAt: `2026-08-22T1${i}:00:00.000Z`,
          sig: `sig-${i}`,
          body: b.body,
        })),
        updatedAt: PUBLISHED_AT,
      }),
    ),
  )
}

describe('integration: a post’s conversation', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({
        did: 'did:plc:reader',
        handle: 'reader.test',
      }),
    )
  })

  it('offers nothing at all on a channel that never turned comments on', async () => {
    // Absent reads as off, so every channel written before the field is a quiet one — the
    // calm shape stays available rather than contradicted.
    manifestSays(undefined)
    published([{ actor: 'did:dht:bob', body: 'should not show' }])
    render(<CommentThread item={ITEM} />)

    await waitFor(() => {
      expect(screen.queryByText('Comments')).toBeNull()
    })
    expect(screen.queryByPlaceholderText('Say something')).toBeNull()
    expect(screen.queryByText('should not show')).toBeNull()
  })

  it('shows what the author published', async () => {
    manifestSays(true)
    published([
      { actor: 'did:dht:bob', body: 'first thing' },
      { actor: 'did:dht:carol', body: 'second thing' },
    ])
    render(<CommentThread item={ITEM} />)

    expect(await screen.findByText('first thing')).toBeTruthy()
    expect(await screen.findByText('second thing')).toBeTruthy()
  })

  it('says so when nobody has commented', async () => {
    manifestSays(true)
    render(<CommentThread item={ITEM} />)
    expect(await screen.findByText('Nothing here yet.')).toBeTruthy()
  })

  it('writes a comment into the doc as a signed record', async () => {
    // What the Curator picks up. Verified through pin-core, because a record that doesn't
    // hold up is one the author would refuse and nothing here would say so.
    manifestSays(true)
    render(<CommentThread item={ITEM} />)

    const box = await screen.findByPlaceholderText('Say something')
    await userEvent.type(box, 'worth saying')
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(async () => {
      expect(await listRecords(comment_collection())).toHaveLength(1)
    })
    const rkeys = await listRecords(comment_collection())
    const raw = docStore.get(`${comment_collection()}/${rkeys[0]}`)
    const record = JSON.parse(new TextDecoder().decode(raw as Uint8Array))
    expect(record.kind).toBe('comment')
    expect(record.body).toBe('worth saying')
    // Throws on anything that doesn't hold up, so surviving the call IS the assertion.
    expect(() => endorsement_verify(JSON.stringify(record))).not.toThrow()
  })

  it('does not write an empty comment', async () => {
    // Nothing to say is not a thing to say. A record with no body is one the receiver
    // refuses outright, so the form must never produce one.
    manifestSays(true)
    render(<CommentThread item={ITEM} />)

    const box = await screen.findByPlaceholderText('Say something')
    await userEvent.type(box, '   ')
    expect(
      (screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(await listRecords(comment_collection())).toHaveLength(0)

    // And submitted around the button, which a form can be. Nothing is written either way,
    // and the enforcement is in pin-engagement rather than here: an empty body fails
    // verification, so it cannot be signed at all. The form's own check is redundant
    // defence, and this asserts the outcome rather than crediting the wrong guard.
    fireEvent.submit(box.closest('form') as HTMLFormElement)
    await waitFor(async () => {
      expect(await listRecords(comment_collection())).toHaveLength(0)
    })
  })

  it('counts what it will take in bytes', async () => {
    // The receiver's limit is in bytes, so a form counting characters would let through
    // four times what a host accepts and move the refusal to the signature.
    manifestSays(true)
    render(<CommentThread item={ITEM} />)

    const box = await screen.findByPlaceholderText('Say something')
    await userEvent.type(box, '😀')
    await waitFor(() => {
      expect(screen.getByText(/^4 \/ \d+ bytes$/)).toBeTruthy()
    })
  })
})
