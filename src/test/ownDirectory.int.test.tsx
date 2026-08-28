// Your own profile page, which is assembled rather than resolved.
//
// Everything a directory carries is something this process already holds — the profile, the
// advertised set and the follows are settings, and each manifest is in the doc. Resolving
// your own did:dht spends a DHT lookup and a Sia download to be told what you wrote, and
// answers with what was last PUBLISHED, so a channel created a minute ago is missing from
// your own profile until the identity loop's next pass.
//
// Somebody ELSE's still resolves, because for them there is no local answer — which is the
// asymmetry this locks, in both directions.

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

const resolveIdentityDoc = vi.fn()
vi.mock('../lib/identityDoc', () => ({
  resolveIdentityDoc: (...args: unknown[]) => resolveIdentityDoc(...args),
}))

import { HandleDirectory } from '../components/HandleDirectory'
import { channelKeyFromBase64, encryptForChannel } from '../core/crypto'
import type { ChannelManifest, OwnedChannel } from '../core/types'
import { useAuthStore } from '../stores/auth'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const ME = 'did:dht:me'
// 32 bytes of base64, the shape a channel key travels in.
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

function manifest(name: string): ChannelManifest {
  return {
    version: 1,
    name,
    description: 'from the doc',
    authorPubkey: 'ed25519:aa',
    authorDidDht: ME,
    publishedAt: '2026-08-27T12:00:00.000Z',
    visibility: 'public',
    items: [],
  } as ChannelManifest
}

/** Put an owned channel's manifest where the commit that publishes one puts it. */
async function inTheDoc(channelID: string, name: string) {
  const sealed = await encryptForChannel(
    channelKeyFromBase64(KEY),
    JSON.stringify(manifest(name)),
  )
  docStore.set(`channel/${channelID}`, new TextEncoder().encode(sealed))
}

function owned(over: Partial<OwnedChannel> = {}): OwnedChannel {
  return {
    channelID: 'chan1',
    channelKey: KEY,
    name: 'A channel',
    createdAt: '2026-08-27T11:00:00.000Z',
    visibility: 'public',
    ...over,
  }
}

function signedInWith(myChannels: OwnedChannel[]) {
  mountAs(
    createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
  )
  useAuthStore.setState({
    myDidDht: ME,
    myChannels,
    follows: [],
    profile: {
      $type: 'dev.sia.pin.profile',
      username: 'me',
      displayName: 'Me',
      updatedAt: '2026-08-27T10:00:00.000Z',
    },
  })
}

function directory(handle: string) {
  return (
    <HandleDirectory
      handle={handle}
      onChannelClick={() => {}}
      onHandleClick={() => {}}
      sidebar={<aside />}
      rightSidebar={<aside />}
    />
  )
}

describe('integration: your own directory comes from local state', () => {
  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    resolveIdentityDoc.mockReset()
    resolveIdentityDoc.mockResolvedValue(null)
  })

  it('renders your channels without resolving anything', async () => {
    signedInWith([owned()])
    await inTheDoc('chan1', 'A channel')

    render(directory(ME))

    await waitFor(() => {
      expect(screen.getByText('A channel')).toBeInTheDocument()
    })
    // The description proves it came out of the MANIFEST rather than off the settings
    // entry, which carries a name and nothing else.
    expect(screen.getByText('from the doc')).toBeInTheDocument()
    expect(resolveIdentityDoc).not.toHaveBeenCalled()
  })

  it('shows only what the directory would advertise', async () => {
    // The published set and the local one have to agree, or your own profile tells you
    // something about your reach that isn't true. Unlisted is the half that matters most:
    // it is absent from the directory by construction, and a page that listed it would be
    // the only place claiming otherwise.
    signedInWith([
      owned(),
      owned({ channelID: 'chan2', name: 'Unclaimed', advertised: false }),
      owned({ channelID: 'chan3', name: 'Unlisted', visibility: 'obscure' }),
      owned({ channelID: 'chan4', name: 'Older', visibility: undefined }),
    ])
    await inTheDoc('chan1', 'A channel')
    await inTheDoc('chan2', 'Unclaimed')
    await inTheDoc('chan3', 'Unlisted')
    await inTheDoc('chan4', 'Older')

    render(directory(ME))

    await waitFor(() => {
      expect(screen.getByText('A channel')).toBeInTheDocument()
    })
    expect(screen.queryByText('Unclaimed')).toBeNull()
    expect(screen.queryByText('Unlisted')).toBeNull()
    // Visibility absent means UNKNOWN, and unknown is never advertised — the rule that
    // stops a channel written before the field existed being enumerated on a guess.
    expect(screen.queryByText('Older')).toBeNull()
  })

  it('still resolves somebody else', async () => {
    signedInWith([owned()])
    await inTheDoc('chan1', 'A channel')

    render(directory('did:dht:someoneelse'))

    await waitFor(() => {
      expect(resolveIdentityDoc).toHaveBeenCalled()
    })
    // And it does not quietly show them YOUR channels.
    expect(screen.queryByText('A channel')).toBeNull()
  })
})
