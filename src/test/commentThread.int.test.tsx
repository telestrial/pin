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
  comment_subject,
  endorsement_verify,
  engagement_subject,
  tally_rkey,
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

/** A file on a published comment, as the commenter's record carries it. */
type PublishedFile = {
  url: string
  mimeType: string
  filename: string
  byteSize: number
  contentHash: string
}

/** Put a conversation in the cache the way the Curator's loops would. */
function published(
  bodies: { actor: string; body: string; attachments?: PublishedFile[] }[],
) {
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
          attachments: b.attachments,
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

  it('carries a picked file into the record and onto Sia', async () => {
    // The whole path in one: bytes go up first, then the record names them — so what lands
    // in the doc points at something that is actually there.
    manifestSays(true)
    render(<CommentThread item={ITEM} />)

    const box = await screen.findByPlaceholderText('Say something')
    await userEvent.type(box, 'look at this')
    const picker = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    await userEvent.upload(
      picker,
      new File(['png bytes'], 'shot.png', { type: 'image/png' }),
    )
    expect(await screen.findByText('shot.png')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(async () => {
      expect(await listRecords(comment_collection())).toHaveLength(1)
    })
    const rkeys = await listRecords(comment_collection())
    const raw = docStore.get(`${comment_collection()}/${rkeys[0]}`)
    const record = JSON.parse(new TextDecoder().decode(raw as Uint8Array))
    expect(record.attachments).toHaveLength(1)
    expect(record.attachments[0].mimeType).toBe('image/png')
    expect(record.attachments[0].filename).toBe('shot.png')
    expect(record.attachments[0].url).not.toBe('')
    // Still a record the author would take, files and all.
    expect(() => endorsement_verify(JSON.stringify(record))).not.toThrow()
    // And the picker is empty again, so the next comment does not re-send it.
    expect(screen.queryByText('shot.png')).toBeNull()
  })

  it('lets a picked file be taken back before anything is uploaded', async () => {
    manifestSays(true)
    render(<CommentThread item={ITEM} />)

    const picker = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    await userEvent.upload(
      picker,
      new File(['x'], 'mistake.png', { type: 'image/png' }),
    )
    expect(await screen.findByText('mistake.png')).toBeTruthy()

    await userEvent.click(
      screen.getByRole('button', { name: 'Remove mistake.png' }),
    )
    await waitFor(() => {
      expect(screen.queryByText('mistake.png')).toBeNull()
    })

    // Nothing was written and nothing was uploaded — a comment that is never submitted must
    // leave nothing behind.
    await userEvent.type(
      await screen.findByPlaceholderText('Say something'),
      'just words',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(async () => {
      expect(await listRecords(comment_collection())).toHaveLength(1)
    })
    const rkeys = await listRecords(comment_collection())
    const raw = docStore.get(`${comment_collection()}/${rkeys[0]}`)
    const record = JSON.parse(new TextDecoder().decode(raw as Uint8Array))
    expect(record.attachments).toBeUndefined()
  })

  it('takes only as many files as a record can hold, and says so', async () => {
    // Said rather than silently dropped: a picker that quietly took four of five would
    // publish a comment missing a file the person believed they had attached.
    manifestSays(true)
    const { max_comment_attachments } = await import(
      '../../crates/pin-core/pkg/pin_core.js'
    )
    const cap = max_comment_attachments()
    render(<CommentThread item={ITEM} />)

    const picker = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    await userEvent.upload(
      picker,
      Array.from(
        { length: cap + 1 },
        (_, i) => new File(['x'], `f${i}.png`, { type: 'image/png' }),
      ),
    )

    expect(
      await screen.findByText(`A comment can carry at most ${cap} files`),
    ).toBeTruthy()
    expect(screen.queryByText(`f${cap}.png`)).toBeNull()
    expect(screen.getByText(`f${cap - 1}.png`)).toBeTruthy()
  })

  it('shows the files a published comment carries', async () => {
    manifestSays(true)
    published([
      {
        actor: 'did:dht:bob',
        body: 'with a picture',
        attachments: [
          {
            url: 'sia://missing#encryption_key=k',
            mimeType: 'image/png',
            filename: 'theirs.png',
            byteSize: 12,
            contentHash: 'bafkreitheirs',
          },
        ],
      },
    ])
    render(<CommentThread item={ITEM} />)

    expect(await screen.findByText('with a picture')).toBeTruthy()
    // These bytes are the COMMENTER's, so a URL nobody here can resolve is ordinary rather
    // than an error state — and it says so rather than leaving a blank tile.
    expect(await screen.findByText('theirs.png — unavailable')).toBeTruthy()
  })

  it('renders a comment as a post row, under its author’s own identity', async () => {
    // A comment is written by a PERSON, who has no channel — so the row's heading is their
    // identity rather than a channel's, and it goes through the same component a post's
    // does. Two lookalike rows would drift; one cannot.
    manifestSays(true)
    published([{ actor: 'did:dht:bob', body: 'worth saying' }])
    render(<CommentThread item={ITEM} onHandleClick={() => {}} />)

    expect(await screen.findByText('worth saying')).toBeTruthy()
    // The heading is the commenter and it is reachable, exactly as a post's author is.
    const heading = screen.getByRole('button', { name: /View did:dht:/ })
    expect(heading).toBeTruthy()
    // And an avatar sits beside it — the hash-derived mark, since this DID publishes no
    // profile in the fake world.
    expect(heading.querySelector('div[aria-hidden="true"]')).toBeTruthy()
  })

  it('sends you to whoever wrote a comment', async () => {
    manifestSays(true)
    published([{ actor: 'did:dht:bob', body: 'worth saying' }])
    const opened: string[] = []
    render(<CommentThread item={ITEM} onHandleClick={(h) => opened.push(h)} />)

    await screen.findByText('worth saying')
    await userEvent.click(screen.getByRole('button', { name: /View did:dht:/ }))
    // The DID, never the display name: a name is self-asserted and non-unique, and the
    // identity is the key.
    expect(opened).toEqual(['did:dht:bob'])
  })

  it('colours a commenter’s mark by their DID, not by what they call themselves', async () => {
    // A name is self-asserted and mutable; the DID is the identity. Keying the mark on the
    // name would make somebody renaming themselves change colour, which reads as a
    // different person.
    const { IdentityAvatar } = await import('../components/IdentityAvatar')
    const { container: first } = render(
      <IdentityAvatar didDht="did:dht:bob" name="Bob" />,
    )
    const { container: renamed } = render(
      <IdentityAvatar didDht="did:dht:bob" name="Roberta" />,
    )
    const colourOf = (c: HTMLElement) =>
      (c.querySelector('div[aria-hidden="true"]') as HTMLElement).style
        .backgroundColor
    expect(colourOf(first)).toBe(colourOf(renamed))
    expect(colourOf(first)).not.toBe('')

    // A different person is a different colour.
    const { container: other } = render(
      <IdentityAvatar didDht="did:dht:carol" name="Bob" />,
    )
    expect(colourOf(other)).not.toBe(colourOf(first))
  })

  it('opens one comment’s own page from the thread', async () => {
    manifestSays(true)
    published([{ actor: 'did:dht:bob', body: 'worth saying' }])
    const opened: string[] = []
    render(
      <CommentThread
        item={ITEM}
        onOpenComment={(c) => opened.push(c.body ?? '')}
      />,
    )

    await userEvent.click(await screen.findByText('worth saying'))
    expect(opened).toEqual(['worth saying'])
  })

  it('a comment’s thread is its replies, addressed at the comment', async () => {
    // One level at a time, the way every microblog does it: this shows what was said back
    // to THIS comment, and each of those carries its own count and its own page. The count
    // and the list agree at every level because the fold counts against the subject a
    // record names.
    manifestSays(true)
    const parent = {
      actor: 'did:dht:bob',
      createdAt: '2026-08-25T09:00:00.000Z',
    }
    const replySubject = comment_subject(parent.actor, parent.createdAt)
    docStore.set(
      `thread/${thread_rkey(CHANNEL_ID, replySubject)}`,
      new TextEncoder().encode(
        JSON.stringify({
          comments: [
            {
              kind: 'comment',
              actor: 'did:dht:carol',
              subject: replySubject,
              version: 'sig-of-parent',
              createdAt: '2026-08-25T10:00:00.000Z',
              sig: 'sig-carol',
              body: 'answering that',
            },
          ],
          updatedAt: PUBLISHED_AT,
        }),
      ),
    )

    render(
      <CommentThread
        item={{ ...ITEM, contentHash: 'sig-of-parent', comment: parent }}
      />,
    )

    // The reply is what shows, read from the parent COMMENT's address rather than the
    // post's.
    expect(await screen.findByText('answering that')).toBeTruthy()
  })

  it('renders a mention in a comment as a link to whoever it names', async () => {
    // A comment carries facets exactly as a post does, and goes through the same renderer —
    // so what a reader clicks resolves to the DID the commenter picked rather than to an
    // @name that matches nobody.
    manifestSays(true)
    const subject = engagement_subject(CHANNEL_ID, PUBLISHED_AT, undefined)
    docStore.set(
      `thread/${thread_rkey(CHANNEL_ID, subject)}`,
      new TextEncoder().encode(
        JSON.stringify({
          comments: [
            {
              kind: 'comment',
              actor: 'did:dht:bob',
              subject,
              version: 'bafkreiabc',
              createdAt: '2026-08-26T10:00:00.000Z',
              sig: 'sig-bob',
              body: 'ask @alice',
              facets: [
                {
                  index: { byteStart: 4, byteEnd: 10 },
                  features: [
                    {
                      $type: 'pin.mention',
                      did: 'did:dht:alice',
                      handle: 'alice',
                    },
                  ],
                },
              ],
            },
          ],
          updatedAt: PUBLISHED_AT,
        }),
      ),
    )

    const opened: string[] = []
    render(<CommentThread item={ITEM} onHandleClick={(h) => opened.push(h)} />)

    const link = await screen.findByText('@alice')
    expect(link.getAttribute('data-mention-handle')).toBe('alice')
    await userEvent.click(link)
    expect(opened).toEqual(['alice'])
  })

  it('gives a comment the same gestures a post has', async () => {
    // The point of one row with two adapters: a comment is likeable, keepable and
    // circulable exactly as a post is, and its comment count is its replies. The
    // hand-rolled row this replaced offered only two of the four.
    manifestSays(true)
    published([{ actor: 'did:dht:bob', body: 'worth saying' }])
    render(<CommentThread item={ITEM} />)

    expect(await screen.findByText('worth saying')).toBeTruthy()
    // A like, which a comment could not carry before.
    expect(screen.getByTitle('Like')).toBeTruthy()
    // And a repost, offered because this channel is public.
    expect(screen.getByLabelText('Repost')).toBeTruthy()
  })

  it('counts the comment’s own engagement, never the post’s', async () => {
    // The adapter derives a comment's subject from who wrote it and when. Get that wrong
    // and the row silently shows the POST's numbers — a plausible-looking row that is
    // wrong about whose engagement it is reporting.
    manifestSays(true)
    published([{ actor: 'did:dht:bob', body: 'worth saying' }])

    const cache = (subject: string, likes: number) =>
      docStore.set(
        `tally/${tally_rkey(CHANNEL_ID, subject)}`,
        new TextEncoder().encode(
          JSON.stringify({
            kinds: { like: { count: likes, setRoot: 'r', sampleActors: [] } },
            updatedAt: PUBLISHED_AT,
          }),
        ),
      )
    cache(engagement_subject(CHANNEL_ID, PUBLISHED_AT, undefined), 9)
    cache(comment_subject('did:dht:bob', '2026-08-22T10:00:00.000Z'), 2)

    render(<CommentThread item={ITEM} />)

    // The comment's own figure, not the post's.
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument())
    expect(screen.queryByText('9')).toBeNull()
  })

  it('offers no pin on a comment whose author has minted no body object', async () => {
    // Null pin rather than a dead button: there is nothing to take custody OF until there
    // is an address, and a comment whose author never ran a Curator has none.
    manifestSays(true)
    published([{ actor: 'did:dht:bob', body: 'no object yet' }])
    render(<CommentThread item={ITEM} />)

    expect(await screen.findByText('no object yet')).toBeTruthy()
    expect(screen.queryByTitle(/Pin to your storage/)).toBeNull()
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
