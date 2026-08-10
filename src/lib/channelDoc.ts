// Rung 1 of the content-resolution ladder: live-sync a channel from its author's node,
// so a subscriber is PUSHED new posts instead of polling for them.
//
// How it sits next to the rungs below it. Rung 2 (channelLocator) is the durable floor
// — the manifest as a Sia object, found via a K-derived pkarr pointer, and it works
// whether or not the author is online. This module adds a live path ON TOP: the author
// keeps the same manifest ciphertext in a per-channel iroh-docs doc and publishes a
// read ticket for it; a subscriber imports that and gets the author's writes as they
// happen.
//
// Deliberately additive. Nothing here is on the read path — `makeCachingLocatorReader`
// is untouched — so a channel with no ticket, an offline author, or a failed import
// just keeps resolving the way it does today. What arrives here lands on
// `applyIfChanged`, the same fill-in the background revalidate pass uses, so a pushed
// manifest and a polled one are indistinguishable downstream.
//
// Capability shape (probe-verified 2026-07-28): the namespace seed is AppKey-derived,
// so only the author can write; subscribers get a `ShareMode::Read` ticket, which also
// carries the author's node id + relay address. Deriving the namespace from K would be
// simpler but would hand every subscriber a write capability.
//
// SUBSCRIBER SIDE ONLY. Serving an owned channel — copying the sealed manifest into its
// doc, minting the ticket, publishing it — is the Curator's, in
// `crates/pin-curator/src/channeldoc.rs`, where it runs whether or not a webview is
// alive. The two halves therefore live in different languages, and what keeps them
// speaking is the wire format below: the entry key, the ticket's TXT prefix, and the
// sealed-blob shape, each pinned by a test on the Rust side.

import {
  channelKeyFromBase64,
  deriveChannelDocTicketSeed,
} from '../core/crypto'
import type { SubscriptionRef } from '../core/types'
import { decodeChannelManifest } from './channelLocator'
import { applyIfChanged } from './channelRevalidate'
import {
  getChannelRecord,
  importChannelDoc,
  isRemoteChange,
  openDocs,
} from './docs'
import { identityFromSeed, reassembleTxt } from './pkarr'
import { pkarrTransport } from './pkarrTransport'

/** TXT record name prefix for the chunked read ticket. */
const TICKET_PREFIX = '_d'

/** Where a channel's manifest lives inside its doc. One record per channel doc — the
 *  doc IS the channel, so it needs no further keyspace. */
const MANIFEST_COLLECTION = 'manifest'
const MANIFEST_RKEY = 'self'

/** Subscriber side: resolve a channel's read ticket off the DHT. Null when the author
 *  publishes no ticket (they may never have run an instance that does), or it hasn't
 *  propagated — either way the caller stays on the rungs below. */
export async function resolveChannelDocTicket(
  channelKeyB64: string,
): Promise<string | null> {
  try {
    const kBytes = channelKeyFromBase64(channelKeyB64)
    const { publicKey } = await identityFromSeed(
      await deriveChannelDocTicketSeed(kBytes),
    )
    const records = await (await pkarrTransport()).resolve(publicKey)
    return reassembleTxt(records, TICKET_PREFIX)
  } catch {
    return null
  }
}

/** Subscriber side: start live-syncing one subscribed channel.
 *
 *  Resolves the author's ticket, imports it (read-only), reads the manifest once for
 *  the initial catch-up, then re-reads whenever the author writes. Returns the
 *  namespace id on success, or null when there's no ticket to import — the ordinary
 *  case for a channel whose author has never run an instance that publishes one.
 *
 *  Re-reads on {@link isRemoteChange}, which covers content-ready as well as
 *  insert-remote: iroh-blobs content lags the entry metadata, so a reader that woke
 *  only on insert-remote would intermittently find the value not yet downloadable.
 *
 *  Never throws — a subscriber's feed must not depend on this rung working. */
export async function syncSubscribedChannelDoc(
  appKeyHex: string,
  sub: SubscriptionRef,
): Promise<string | null> {
  try {
    const ticket = await resolveChannelDocTicket(sub.channelKey)
    if (!ticket) return null
    await openDocs(appKeyHex)
    const kBytes = channelKeyFromBase64(sub.channelKey)

    const read = async (nsId: string) => {
      try {
        const bytes = await getChannelRecord(
          nsId,
          MANIFEST_COLLECTION,
          MANIFEST_RKEY,
        )
        if (!bytes) return
        applyIfChanged(sub, await decodeChannelManifest(kBytes, bytes))
      } catch {
        // Content not downloaded yet, or a malformed entry — the next event (or the
        // polling rung) covers it.
      }
    }

    const nsId = await importChannelDoc(ticket, (ns, kind) => {
      if (isRemoteChange(kind)) void read(ns)
    })
    // Initial catch-up. The import's own events may fire before this resolves, so
    // both paths read; `applyIfChanged` makes a duplicate read a no-op.
    await read(nsId)
    return nsId
  } catch {
    return null
  }
}
