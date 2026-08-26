// Where a post's conversation SITS on the page.
//
// Caught in the app rather than by a test: the thread was a sibling of the post inside the
// page's `lg:flex-row`, so on a wide screen it became a fourth column beside the post
// instead of sitting under it. Every reader had it, and nothing failed — a layout that is
// wrong in one breakpoint renders perfectly in tests that never look at structure.
//
// So this asserts the one structural fact the bug violated: the conversation is INSIDE the
// column the post is in. Not how it looks — what it is nested in.

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import {
  engagement_subject,
  thread_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ReadText } from '../components/read/ReadText'
import type { ChannelManifest, ItemRef } from '../core/types'
import { useFeedStore } from '../stores/feed'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const CHANNEL_ID = 'chan1'
const PUBLISHED_AT = '2026-08-26T12:00:00.000Z'

const ITEM = {
  id: 'obj1',
  itemURL: 'sia://fake/obj1#k=obj1',
  type: 'text',
  title: '',
  summary: 'the post itself',
  publishedAt: PUBLISHED_AT,
  mimeType: 'text/markdown',
  byteSize: 15,
  contentHash: 'bafkreiabc',
} as ItemRef

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

function readerProps() {
  return {
    item: ITEM,
    channelName: 'A channel',
    onBack: () => {},
    backLabel: 'Back',
    sidebar: <aside data-testid="sidebar" />,
    rightSidebar: <aside data-testid="right-sidebar" />,
    pinInput: {
      item: ITEM,
      channel: { authorHandle: '', channelID: CHANNEL_ID, name: 'A channel' },
    },
    onHandleClick: () => {},
  }
}

describe('integration: where a post’s conversation sits', () => {
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

  it('puts the conversation inside the post’s column, not beside it', async () => {
    takesComments()
    docStore.set(
      `thread/${thread_rkey(CHANNEL_ID, engagement_subject(CHANNEL_ID, PUBLISHED_AT, undefined))}`,
      new TextEncoder().encode(
        JSON.stringify({
          comments: [
            {
              kind: 'comment',
              actor: 'did:dht:bob',
              subject: 'sub',
              version: 'bafkreiabc',
              createdAt: '2026-08-26T13:00:00.000Z',
              sig: 'sig-bob',
              body: 'said underneath',
            },
          ],
          updatedAt: PUBLISHED_AT,
        }),
      ),
    )

    const { container } = render(<ReadText {...readerProps()} />)
    await waitFor(() => {
      expect(screen.getByText('said underneath')).toBeInTheDocument()
    })

    const article = container.querySelector('article')
    // Anchored on the composer rather than a heading — the conversation carries no label,
    // the same as the feed's composer.
    const thread = screen
      .getByPlaceholderText('Say something')
      .closest('section')
    expect(article).toBeTruthy()
    expect(thread).toBeTruthy()

    // The load-bearing assertion: the conversation is a DESCENDANT of whatever holds the
    // post, so it lays out under it. As siblings inside the page's row they lay out side by
    // side, which is what the bug was.
    const column = article?.parentElement
    expect(column?.contains(thread as Node)).toBe(true)

    // And that column is not the page row itself — the row holds the sidebars, and a
    // conversation in there is a column of its own again.
    expect(column?.querySelector('[data-testid="sidebar"]')).toBeNull()
    expect(column?.querySelector('[data-testid="right-sidebar"]')).toBeNull()
  })
})
