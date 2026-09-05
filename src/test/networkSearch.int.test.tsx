// The search box, and where a pick sends you.
//
// The query itself is covered in `directorySearch.test.ts` against a graph oracle; what
// this covers is the seam either side of it — that the corpus really comes out of the
// crawl's records in the doc, and that picking a result opens the thing that was found.
// A channel hit is the one that has to work: it is the first way into Pin that is not a
// link somebody sent you.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/docs', async () =>
  (await import('./fakeModules')).fakeDocsModule(),
)

import { cleanup } from '@testing-library/react'
import { directory_collection } from '../../crates/pin-core/pkg/pin_core.js'
import { NetworkSearch } from '../components/NetworkSearch'
import { fakeDocStore as docStore } from './fakeModules'
import { createFakeApp, mountAs, resetAllStores } from './setupFakeApp'

const THEM = 'did:dht:them'

/** A directory record as the crawl writes one. */
function hold(
  didDht: string,
  username: string,
  channels: { channelID: string; key: string; name: string }[],
  tier = 'full',
) {
  docStore.set(
    `${directory_collection()}/${didDht}`,
    new TextEncoder().encode(
      JSON.stringify({
        tier,
        profile: { username, displayName: username },
        channels,
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

const RUST = { channelID: 'chan-rust', key: 'K-rust', name: 'Rust Weekly' }

describe('searching your network', () => {
  const onPerson = vi.fn()
  const onChannel = vi.fn()

  beforeEach(() => {
    resetAllStores()
    docStore.clear()
    onPerson.mockReset()
    onChannel.mockReset()
    mountAs(
      createFakeApp().createAccount({ did: 'did:plc:me', handle: 'me.test' }),
    )
  })
  afterEach(cleanup)

  function box() {
    return render(<NetworkSearch onPerson={onPerson} onChannel={onChannel} />)
  }

  it('finds a channel in what the crawl recorded', async () => {
    hold(THEM, 'bob', [RUST])
    box()

    await userEvent.type(screen.getByRole('searchbox'), 'rust')

    await waitFor(() =>
      expect(screen.getByText('Rust Weekly')).toBeInTheDocument(),
    )
  })

  it('opens the channel that was picked', async () => {
    // The whole point of a channel hit: an advertised channel publishes its K, so what is
    // found can be opened rather than only named.
    hold(THEM, 'bob', [RUST])
    box()

    await userEvent.type(screen.getByRole('searchbox'), 'rust')
    await waitFor(() => screen.getByText('Rust Weekly'))
    await userEvent.click(screen.getByText('Rust Weekly'))

    expect(onChannel).toHaveBeenCalledWith(THEM, 'chan-rust')
  })

  it('opens the person that was picked', async () => {
    hold(THEM, 'bob', [])
    box()

    await userEvent.type(screen.getByRole('searchbox'), 'bob')
    await waitFor(() => screen.getByText('@bob'))
    await userEvent.click(screen.getByText('@bob'))

    expect(onPerson).toHaveBeenCalledWith(THEM)
  })

  it('offers nothing until something is typed', async () => {
    // A dropdown that listed the whole index on focus is a list of everybody, which is
    // not what taking the box means.
    hold(THEM, 'bob', [RUST])
    box()

    await userEvent.click(screen.getByRole('searchbox'))
    await new Promise((r) => setTimeout(r, 10))

    expect(screen.queryByText('Rust Weekly')).toBeNull()
    expect(screen.queryByText('@bob')).toBeNull()
    // And no dropdown at all, which is the half the rows cannot cover: an empty query
    // matches nothing either way, so without this the box would sit open under the
    // cursor reporting that it found nothing before anybody asked it for anything.
    expect(screen.queryByText(/Curator has read/)).toBeNull()
    expect(screen.queryByText(/Reading your index/)).toBeNull()
  })

  it('says a miss is the limit of what has been read', async () => {
    // Never "no such person". The index holds what the crawl has REACHED, so a miss is a
    // statement about our own reach — claiming otherwise would assert something about the
    // network that nothing here knows.
    hold(THEM, 'bob', [RUST])
    box()

    await userEvent.type(screen.getByRole('searchbox'), 'nobody')

    await waitFor(() =>
      expect(screen.getByText(/Curator has read/)).toBeInTheDocument(),
    )
  })

  it('finds nobody a faded record could have named', async () => {
    // A faded record dropped its profile and channels, so it reaches the corpus with no
    // name to match. Listing it would put a bare did in the dropdown.
    hold(THEM, 'bob', [RUST], 'reduced')
    box()

    await userEvent.type(screen.getByRole('searchbox'), 'rust')

    await waitFor(() =>
      expect(screen.getByText(/Curator has read/)).toBeInTheDocument(),
    )
  })
})
