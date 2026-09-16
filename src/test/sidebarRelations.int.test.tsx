// What the sidebar's list is, now that following and watching are one relation.
//
// A subscription is the MECHANISM under both — it is what carries K and what the pull loop
// reads — so a list of subscriptions is a list of what reaches you at either visibility.
// That makes it the superset, and the profile's Following section the public subset of it:
// two surfaces, one relation, different audiences.
//
// So the list is titled for the superset and the private entries are marked, which is the
// direction that stays true as the set grows: public is what the heading says, so the
// exception is the thing worth showing.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { Sidebar } from '../components/Sidebar'
import type { FollowEdge, SubscriptionRef } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const THEM = 'did:dht:them'

function sub(channelID: string, cachedName: string): SubscriptionRef {
  return {
    authorHandle: '',
    authorDID: '',
    didDht: THEM,
    channelID,
    channelKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    cachedName,
    addedAt: '2026-09-01T00:00:00.000Z',
  }
}

function sidebar() {
  return render(
    <Sidebar
      onHome={() => {}}
      onCurate={() => {}}
      onSettings={() => {}}
      onCreate={() => {}}
      onOpenLink={() => {}}
      onSeeAll={() => {}}
      onChannelClick={() => {}}
    />,
  )
}

describe('integration: the sidebar lists what reaches you', () => {
  beforeEach(() => {
    resetAllStores()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  function signedInWith(
    subscriptions: SubscriptionRef[],
    follows: FollowEdge[] = [],
  ) {
    useAuthStore.setState({ subscriptions, follows, myChannels: [] })
  }

  it('lists a followed channel and a watched one together', async () => {
    // One list, because they are one relation at two visibilities. Splitting them would
    // ask a reader to hold a distinction that does not change what reaches them.
    signedInWith(
      [sub('c-followed', 'Followed'), sub('c-watched', 'Watched')],
      [{ didDht: THEM, channelID: 'c-followed', name: 'Followed' }],
    )

    sidebar()

    expect(screen.getByText('Followed')).toBeInTheDocument()
    expect(screen.getByText('Watched')).toBeInTheDocument()
  })

  it('marks only the private one', async () => {
    // The mark is on WATCHING rather than on following: the heading already says
    // following, so what is worth showing on a row is the entry that says nothing in
    // public. Reversing it would tag most of the list to say what the heading said.
    signedInWith(
      [sub('c-followed', 'Followed'), sub('c-watched', 'Watched')],
      [{ didDht: THEM, channelID: 'c-followed', name: 'Followed' }],
    )

    sidebar()

    const marks = screen.getAllByText('Watching')
    expect(marks).toHaveLength(1)
    // On the watched row, not the followed one.
    expect(marks[0].closest('li')).toHaveTextContent('Watched')
  })

  it('marks nothing when every entry is public', async () => {
    signedInWith(
      [sub('c-followed', 'Followed')],
      [{ didDht: THEM, channelID: 'c-followed', name: 'Followed' }],
    )

    sidebar()

    expect(screen.queryByText('Watching')).toBeNull()
  })
})
