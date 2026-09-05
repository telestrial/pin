// Rendering a person's name and avatar, and where those come from.
//
// `PostRow` asks for three of these per row, so this is the hottest read in the app: a
// fifty-row feed used to spend a DHT lookup and a Sia download per person on every reload.
// What the crawl records makes that a doc read instead — but only if the rungs are tried
// in the right order, so every case here stocks the crawl's record and the network with
// DIFFERENT answers and asserts which one was rendered.
//
// The session cache inside the hook is module-level and survives between tests by design
// (it is a per-session cache, not per-render), so each case uses its own did — a shared one
// would have the first case answering the second.

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/pkarr', async () =>
  (await import('./fakeModules')).fakePkarrModule(),
)
vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { cleanup } from '@testing-library/react'
import {
  directory_collection,
  request_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
import { DIRECTORY_DOC_VERSION } from '../core/identityDoc'
import {
  useIdentityName,
  useIdentityProfile,
} from '../lib/hooks/useIdentityName'
import { useAuthStore } from '../stores/auth'
import { fakeDocStore as docStore, publishFakeDirectory } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

/** What a row renders for one person. */
function Person({ didDht }: { didDht: string }) {
  const name = useIdentityName(didDht)
  const profile = useIdentityProfile(didDht)
  return (
    <div>
      <span data-testid="name">{name}</span>
      <span data-testid="avatar">{profile?.avatarURL ?? 'none'}</span>
    </div>
  )
}

function hold(
  didDht: string,
  username: string,
  avatarURL: string,
  tier = 'full',
) {
  docStore.set(
    `${directory_collection()}/${didDht}`,
    new TextEncoder().encode(
      JSON.stringify({
        tier,
        profile:
          tier === 'full'
            ? { username, displayName: username, avatarURL }
            : null,
        channels: [],
        reach: [],
        follows: [],
        handleFollows: [],
        url: 'sia://held',
        epoch: 1,
        seenAt: '2026-09-01T12:00:00.000Z',
      }),
    ),
  )
}

async function publish(didDht: string, username: string, avatarURL: string) {
  await publishFakeDirectory(didDht, {
    version: DIRECTORY_DOC_VERSION,
    profile: { username, displayName: username, avatarURL },
    channels: [],
    follows: [],
    handleFollows: [],
    updatedAt: new Date().toISOString(),
  })
}

describe('rendering a person', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  it('renders them from what the crawl holds rather than resolving again', async () => {
    const them = 'did:dht:heldperson'
    hold(them, 'from-the-index', 'sia://held-avatar')
    await publish(them, 'from-the-network', 'sia://network-avatar')

    render(<Person didDht={them} />)

    await waitFor(() =>
      expect(screen.getByTestId('name')).toHaveTextContent('from-the-index'),
    )
    // The avatar too, not only the name: the profile is cached whole because the fetch
    // was the same one either way, and keeping one field would make an avatar cost a second
    // round trip for bytes already in hand.
    expect(screen.getByTestId('avatar')).toHaveTextContent('sia://held-avatar')
  })

  it('resolves someone the crawl has never read', async () => {
    const them = 'did:dht:uncrawledperson'
    await publish(them, 'from-the-network', 'sia://network-avatar')

    render(<Person didDht={them} />)

    await waitFor(() =>
      expect(screen.getByTestId('name')).toHaveTextContent('from-the-network'),
    )
  })

  it('resolves someone whose record has faded rather than reading it as no name', async () => {
    // A faded record kept its endpoints and dropped its profile, so an empty profile
    // there means the crawl let it go — not that they publish none. Reading it as an
    // answer names them `did:dht:…` forever, because nothing else would ever look at
    // them again.
    const them = 'did:dht:fadedperson'
    hold(them, '', '', 'reduced')
    await publish(them, 'from-the-network', 'sia://network-avatar')

    render(<Person didDht={them} />)

    await waitFor(() =>
      expect(screen.getByTestId('name')).toHaveTextContent('from-the-network'),
    )
  })

  it('asks the crawl to read a faded record again', async () => {
    // The other half, and the one that outlives the session: a request is the only thing
    // that brings a faded profile back, since the refresh rotation re-reads the full tier
    // and a faded record is by definition outside it.
    const them = 'did:dht:fadedandwanted'
    hold(them, '', '', 'minimal')
    await publish(them, 'from-the-network', 'sia://network-avatar')

    render(<Person didDht={them} />)

    await waitFor(() =>
      expect(docStore.has(`${request_collection()}/${them}`)).toBe(true),
    )
  })

  it('asks for nobody it could name from a full record', async () => {
    // A request spends the crawl's budget. A record that still carries its profile
    // answered the question, so asking again would re-read what is already held.
    const them = 'did:dht:heldandquiet'
    hold(them, 'from-the-index', 'sia://held-avatar')

    render(<Person didDht={them} />)

    await waitFor(() =>
      expect(screen.getByTestId('name')).toHaveTextContent('from-the-index'),
    )
    expect(docStore.has(`${request_collection()}/${them}`)).toBe(false)
  })

  it('renders your own name from local state, never from either rung', async () => {
    // The one identity that must not be looked up anywhere: settings is the truth, and
    // both the published document and the crawl's copy of it lag a local edit. Stocking
    // both rungs with a stale name is what makes this assertion mean something.
    const me = 'did:dht:myself'
    hold(me, 'stale-in-the-index', 'sia://stale-avatar')
    await publish(me, 'stale-on-the-network', 'sia://stale-avatar')
    useAuthStore.setState({
      myDidDht: me,
      profile: {
        $type: 'dev.sia.pin.profile',
        username: 'just-renamed',
        displayName: 'Just Renamed',
        avatarURL: 'sia://my-new-avatar',
        updatedAt: new Date().toISOString(),
      },
    })

    // Two separate properties, and only one of them is visible in the output: what gets
    // RENDERED comes from settings, and no lookup is SPENT at all. Watching the doc read
    // covers the second, which the rendered name cannot — the display branch would go on
    // returning the local profile even if the effect resolved behind it.
    const looked = vi.spyOn(docStore, 'get')

    render(<Person didDht={me} />)

    expect(screen.getByTestId('name')).toHaveTextContent('just-renamed')
    expect(screen.getByTestId('avatar')).toHaveTextContent(
      'sia://my-new-avatar',
    )
    // Still local a tick later: an effect firing behind the first render would overwrite
    // the fresh name with the stale one, which is the shape this would regress into.
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.getByTestId('name')).toHaveTextContent('just-renamed')
    expect(looked).not.toHaveBeenCalledWith(`${directory_collection()}/${me}`)
    looked.mockRestore()
  })

  it('names someone unreachable by a short did rather than dropping them', async () => {
    const them = 'did:dht:nowhereperson'

    render(<Person didDht={them} />)

    await waitFor(() =>
      expect(screen.getByTestId('name')).toHaveTextContent('did:dht:…person'),
    )
  })
})
