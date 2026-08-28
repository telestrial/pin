// A comment on its own page, and what is shown BENEATH it.
//
// The page had no test at all, which the 08-26 sweep found the hard way: dropping the files
// from the component all three comment surfaces share broke the thread's site and the feed's
// and left this one silent.
//
// The claim worth locking is the one this page alone makes. A reply is a comment whose
// SUBJECT is the comment above it, so the thread here has to be addressed to that comment —
// and the way to get it wrong is to rebuild the address from the post and drop the comment
// off it, which shipped twice in two days elsewhere. Both bugs render perfectly: you get a
// conversation, it is just somebody else's.

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import {
  comment_subject,
  engagement_subject,
  thread_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
import { CommentPage } from '../components/CommentPage'
import type { ChannelManifest } from '../core/types'
import type { PublishedComment } from '../lib/channelConversations'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const CHANNEL_ID = 'chan1'
const PUBLISHED_AT = '2026-08-27T12:00:00.000Z'
const CHANNEL = {
  authorHandle: '',
  authorDidDht: 'did:dht:author',
  channelID: CHANNEL_ID,
  name: 'A channel',
}
const POST = { channelID: CHANNEL_ID, publishedAt: PUBLISHED_AT }

/** The comment this page is about — the head of the thread. */
const COMMENT: PublishedComment = {
  kind: 'comment',
  actor: 'did:dht:bob',
  subject: 'post-subject',
  version: 'bafkreiabc',
  createdAt: '2026-08-27T13:00:00.000Z',
  sig: 'sig-bob',
  body: 'what bob said',
  attachments: [
    {
      url: 'sia://fake/att#k=att',
      mimeType: 'image/png',
      filename: 'bob.png',
      byteSize: 12,
      contentHash: 'bafkreiatt',
    },
  ],
}

function takesComments() {
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
        comments: true,
        items: [],
      } as ChannelManifest,
    },
  })
}

/** Publish a conversation under one subject, as the Curator's loops would. */
function conversationAt(subject: string, bodies: string[]) {
  docStore.set(
    `thread/${thread_rkey(CHANNEL_ID, subject)}`,
    new TextEncoder().encode(
      JSON.stringify({
        comments: bodies.map((body, i) => ({
          kind: 'comment',
          actor: 'did:dht:carol',
          subject,
          version: 'bafkreiabc',
          createdAt: `2026-08-27T14:0${i}:00.000Z`,
          sig: `sig-reply-${i}`,
          body,
        })),
        updatedAt: PUBLISHED_AT,
      }),
    ),
  )
}

function page() {
  return (
    <CommentPage
      comment={COMMENT}
      post={POST}
      channel={CHANNEL}
      onBack={() => {}}
      backLabel="Back"
      sidebar={<aside data-testid="sidebar" />}
      rightSidebar={<aside data-testid="right-sidebar" />}
    />
  )
}

describe('integration: a comment on its own page', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    takesComments()
    mountAs(
      createFakeApp().createAccount({
        did: 'did:plc:reader',
        handle: 'reader.test',
      }),
    )
  })

  it('shows the replies to THIS comment, not the post’s conversation', async () => {
    // Both exist, which is the ordinary case: a post with several comments, one of which
    // has replies. Addressed by the post, this page would show the siblings.
    conversationAt(comment_subject(COMMENT.actor, COMMENT.createdAt), [
      'a reply to bob',
    ])
    conversationAt(engagement_subject(CHANNEL_ID, PUBLISHED_AT, undefined), [
      'a different comment on the post',
    ])

    render(page())

    await waitFor(() => {
      expect(screen.getByText('a reply to bob')).toBeInTheDocument()
    })
    expect(screen.queryByText('a different comment on the post')).toBeNull()
  })

  it('renders the comment itself through the shared contents — words and files', async () => {
    // What the 08-26 sabotage exposed: this page assembled a comment's parts of its own
    // accord, so a change to the component the other two sites share left it untouched
    // and silent. The files are the half that had already gone missing once.
    conversationAt(comment_subject(COMMENT.actor, COMMENT.createdAt), [])

    render(page())

    expect(screen.getByText('what bob said')).toBeInTheDocument()
    // Where it was said, so a comment lifted out of its thread is not a decontextualized
    // quote.
    expect(screen.getByText(/Replying to A channel/)).toBeInTheDocument()
    // The bytes are the COMMENTER's, and this reader cannot resolve them — which is the
    // ordinary state for a comment's media and says so rather than leaving a blank tile.
    // What matters here is that the tile is drawn at all: the files reached the grid.
    expect(await screen.findByText('bob.png — unavailable')).toBeInTheDocument()
  })
})
