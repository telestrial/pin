// The channel commands' argument names, as the desktop sends them.
//
// A plain `#[tauri::command]` takes its arguments in camelCase as Tauri spells it, which
// knows word boundaries and not acronyms — `item_url` is `itemUrl`, never `itemURL`. This
// repo shipped `itemURL` to `channel_fetch_tallies`, and the failure was silent: the read
// failed inside a catch and the page showed no counts. So the full key set is asserted.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(
  async (_cmd: string, _args: Record<string, unknown>) => null,
)
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('the channel commands over Tauri', () => {
  beforeEach(() => {
    invoke.mockClear()
  })

  it('names a tallies URL as Tauri spells item_url', async () => {
    const { makeTauriChannelLocator } = await import('./tauriChannelLocator')
    const locator = await makeTauriChannelLocator()
    const key = new Uint8Array([1, 2])

    await locator.fetchTallies(key, 'did:dht:a', 'sia://t', 'ab')
    await locator.fetchFollowerCount(key, 'did:dht:a', 'sia://t')

    expect(invoke.mock.calls).toEqual([
      [
        'channel_fetch_tallies',
        {
          channelKey: [1, 2],
          author: 'did:dht:a',
          itemUrl: 'sia://t',
          appKeyHex: 'ab',
        },
      ],
      [
        'channel_fetch_follower_count',
        { channelKey: [1, 2], author: 'did:dht:a', itemUrl: 'sia://t' },
      ],
    ])
  })

  it('names the follower audit as Tauri spells it', async () => {
    const { makeTauriChannelLocator } = await import('./tauriChannelLocator')
    const locator = await makeTauriChannelLocator()
    await locator.auditFollowers(
      new Uint8Array([3]),
      'did:dht:a',
      'ab',
      'did:dht:me',
    )
    expect(invoke.mock.calls).toEqual([
      [
        'channel_audit_followers',
        {
          channelKey: [3],
          author: 'did:dht:a',
          appKeyHex: 'ab',
          viewer: 'did:dht:me',
        },
      ],
    ])
  })

  it('reads no count as null', async () => {
    const { makeTauriChannelLocator } = await import('./tauriChannelLocator')
    const locator = await makeTauriChannelLocator()
    await expect(
      locator.fetchFollowerCount(new Uint8Array(), 'did:dht:a', 'sia://t'),
    ).resolves.toBeNull()
  })
})
