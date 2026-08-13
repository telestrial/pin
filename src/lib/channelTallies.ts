// What a channel's readers endorsed, as reached from a screen.
//
// A count reaches this identity by two rungs, neither of which a screen can read
// directly. The fast one is a live-synced copy of the author's own fold, which lands in
// the channel's own iroh-docs replica — a subscriber only learns that replica's namespace
// by importing a ticket, and for a channel you own it is derived from a seed the UI has
// no other reason to hold. The durable one is a per-channel map on Sia behind a DHT
// resolve and a download, which everyone holding K can reach and nobody wants to walk per
// row.
//
// So the Curator's loops land both at one address in this identity's own doc — the
// engagement loop for a channel it owns, the pull loop for a subscribed one — and a row
// reads that. The same arrangement `sub/<channelID>` gives a manifest, and read the same
// way: prefer what's cached, resolve fresh when it isn't there.

import {
  engagement_subject,
  tally_collection,
  tally_rkey,
} from '../../crates/pin-core/pkg/pin_core.js'
import { channelKeyFromBase64 } from '../core/crypto'
import { ensureWasm } from '../core/wasm'
import { fetchTallies, resolveTalliesUrl } from './channelLocatorNative'
import { getRecord, openDocs, putRecord } from './docs'
import type { EndorsedItem } from './engagement'

/** One gesture's count for one item.
 *
 *  `count` is always the size of a backing set rather than a running total, and `setRoot`
 *  is a commitment over that exact set — which is what lets an auditor ask for arbitrary
 *  members instead of whichever ones the holder chose to show.
 *
 *  `retentionCheckedAt` is when the holder last re-read the actors' own records to confirm
 *  these endorsements still stand. Absent means never. It lags a little by design: the
 *  cache is only rewritten when a count moves, so a stale stamp understates how recently
 *  the check ran and never overstates it. */
export type KindTally = {
  count: number
  setRoot: string
  sampleActors: string[]
  retentionCheckedAt?: string
}

/** Everything counted about one item, by gesture. Kinds are open on the wire — a reader
 *  renders the ones it understands and ignores the rest. */
export type Aggregate = {
  kinds: Record<string, KindTally>
  updatedAt: string
}

/** The subject an item's counts are filed under: a hash over the channel and the item,
 *  so it is unique without qualification and names nothing to anyone without K. */
export async function tallySubject(item: EndorsedItem): Promise<string> {
  await ensureWasm()
  return engagement_subject(item.channelID, item.publishedAt, item.attachment)
}

async function tallyAddress(item: EndorsedItem): Promise<[string, string]> {
  await ensureWasm()
  return [
    tally_collection(),
    tally_rkey(item.channelID, await tallySubject(item)),
  ]
}

/** An item's counts as this identity currently holds them, or null when nothing is
 *  cached — which is ordinary, and means the same thing as a count of zero: nobody has
 *  endorsed it, or no pass has read the counts for its channel yet. */
export async function readTally(
  appKeyHex: string,
  item: EndorsedItem,
): Promise<Aggregate | null> {
  try {
    await openDocs(appKeyHex)
    const [collection, rkey] = await tallyAddress(item)
    const stored = await getRecord(collection, rkey)
    if (!stored) return null
    return JSON.parse(new TextDecoder().decode(stored)) as Aggregate
  } catch {
    // A cache that won't open or won't parse reads as no counts, which is what a row
    // shows anyway. Nothing about a count is worth failing a render over.
    return null
  }
}

/** Read one channel's published counts and cache them, for a channel no pass has covered
 *  yet — a just-pasted subscribe URL, or a tab whose loop hasn't come round.
 *
 *  The fall-through rung, and the counterpart of resolving a manifest when the cache
 *  misses. Best-effort and unawaited by its caller: counts arriving a moment after the
 *  posts they belong to is the whole shape of this, and a channel with no published
 *  counts is the common case rather than a failure. */
export async function warmChannelTallies(
  appKeyHex: string,
  channelID: string,
  channelKeyB64: string,
): Promise<void> {
  try {
    const k = channelKeyFromBase64(channelKeyB64)
    const itemURL = await resolveTalliesUrl(k)
    if (!itemURL) return

    const map = JSON.parse(await fetchTallies(k, itemURL)) as Record<
      string,
      Aggregate
    >
    await openDocs(appKeyHex)
    await ensureWasm()
    const collection = tally_collection()
    const encoder = new TextEncoder()
    for (const [subject, aggregate] of Object.entries(map)) {
      await putRecord(
        collection,
        tally_rkey(channelID, subject),
        encoder.encode(JSON.stringify(aggregate)),
      )
    }
  } catch {
    // The Curator's pull loop covers this channel on its own cadence, so a failure here
    // costs a pass rather than the counts.
  }
}
