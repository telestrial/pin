// The channels this identity reads, worked out by the Curator's own function.
//
// A watch is one channel. A follow of a person is their profile feed — the channels they
// advertise and have not taken off their profile — read out of the crawl's record of them.
// Nothing is copied into the subscription list for the second, which is why this exists:
// the feed has to learn a followed person's channels from somewhere, and it learns them
// from the same answer the pull loop caches by.

import { reading_channels } from '../../crates/pin-core/pkg/pin_core.js'
import type { SubscriptionRef } from '../core/types'
import { ensureWasm } from '../core/wasm'
import { type DirectoryRecord, readDirectory } from './directories'

/** What the set came to: the channels, and the followed people it could not answer for. */
export type Reading = {
  channels: SubscriptionRef[]
  /** Followed people with no full record held yet. Their channels are missing for want
   *  of a reading, so nothing may be dropped on the strength of their absence. */
  unsettled: string[]
}

type ReadChannel = {
  channelID: string
  channelKey: string
  didDht?: string
  followedName?: string
}

/** The set, computed over the watches given and the crawl's record of each person
 *  followed. A watch comes back as the very object passed in. */
export async function computeReading(
  appKeyHex: string,
  subscriptions: readonly SubscriptionRef[],
  handleFollows: readonly string[],
): Promise<Reading> {
  const held: Record<string, DirectoryRecord> = {}
  await Promise.all(
    handleFollows.map(async (did) => {
      const record = await readDirectory(appKeyHex, did)
      if (record) held[did] = record
    }),
  )
  await ensureWasm()
  const out = JSON.parse(
    reading_channels(
      JSON.stringify({ subscriptions, handleFollows }),
      JSON.stringify(held),
    ),
  ) as { channels: ReadChannel[]; unsettled: string[] }

  const watched = new Map(subscriptions.map((s) => [s.channelID, s]))
  return {
    channels: out.channels.map(
      (c) =>
        watched.get(c.channelID) ?? {
          // The feed reads these by their K-derived locator, like any did:dht watch,
          // so the atproto-era fields stay empty.
          authorHandle: '',
          authorDID: '',
          didDht: c.didDht,
          channelID: c.channelID,
          channelKey: c.channelKey,
          cachedName: c.followedName,
          addedAt: '',
        },
    ),
    unsettled: out.unsettled,
  }
}
