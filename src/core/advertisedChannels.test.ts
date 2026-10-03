// Which of your channels your directory names. Mirrors `advertised_channels` in the identity
// loop, and the two must agree or your own page misreports your reach.

import { describe, expect, it } from 'vitest'
import { advertisedChannels } from './channels'
import type { OwnedChannel } from './types'

const owned = (
  channelID: string,
  extra: Partial<OwnedChannel> = {},
): OwnedChannel => ({
  channelID,
  channelKey: `k-${channelID}`,
  name: channelID,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...extra,
})

describe('advertisedChannels', () => {
  it('lists public and private channels and nothing else', () => {
    const ids = advertisedChannels([
      owned('pub', { visibility: 'public' }),
      owned('pri', { visibility: 'private' }),
      owned('sec', { visibility: 'secret' }),
      owned('unc', { visibility: 'public', advertised: false }),
      // Unknown visibility is not public, so it is never named.
      owned('old'),
    ]).map((c) => c.channelID)
    expect(ids).toEqual(['pub', 'pri'])
  })
})
