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

import {
  channelKeyFromBase64,
  deriveChannelDocSeed,
  deriveChannelDocTicketSeed,
  encryptForChannel,
} from '../core/crypto'
import type { ChannelManifest, SubscriptionRef } from '../core/types'
import { decodeChannelManifest } from './channelLocator'
import { applyIfChanged } from './channelRevalidate'
import {
  getChannelRecord,
  importChannelDoc,
  isRemoteChange,
  openChannelDoc,
  openDocs,
  putChannelRecord,
  shareChannelDoc,
} from './docs'
import { chunkForTxt, identityFromSeed, reassembleTxt } from './pkarr'
import { pkarrTransport } from './pkarrTransport'

/** TXT record name prefix for the chunked read ticket. */
const TICKET_PREFIX = '_d'

/** Where a channel's manifest lives inside its doc. One record per channel doc — the
 *  doc IS the channel, so it needs no further keyspace. */
const MANIFEST_COLLECTION = 'manifest'
const MANIFEST_RKEY = 'self'

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Author side: mirror a channel's manifest into its own doc and publish a read
 *  ticket for it, so subscribers can live-sync.
 *
 *  The doc entry holds the EXACT same ciphertext the Sia object does (encrypted under
 *  K), so a subscriber decrypts a pushed manifest with the identical code path as a
 *  resolved one — no second format, and whatever relays the bytes stays content-blind.
 *
 *  Ordered the same way a channel write is: put the content, CONFIRM it's there, then
 *  publish the record that advertises it. The ticket is a claim that this doc holds the
 *  manifest, so minting one without reading the entry back would advertise a capability
 *  to content we never verified — the analog of publishing a pointer to bytes that
 *  didn't land. The read-back is a local doc read, so confirming is nearly free.
 *
 *  Deliberately NOT part of `commitChannelManifest`, though: a publish is "done" when
 *  the Sia object and the pkarr locator are live. Folding iroh into that bar would let
 *  the fast rung fail a publish that actually succeeded. This runs alongside and
 *  THROWS on failure, so the caller can retry rather than silently skip. */
export async function publishChannelDoc(
  appKeyHex: string,
  channelID: string,
  channelKeyB64: string,
  manifest: ChannelManifest,
): Promise<{ nsId: string; ticket: string }> {
  const kBytes = channelKeyFromBase64(channelKeyB64)
  const nsId = await openOwnChannelDoc(appKeyHex, channelID)

  const ciphertext = new TextEncoder().encode(
    await encryptForChannel(kBytes, JSON.stringify(manifest)),
  )
  await putChannelRecord(nsId, MANIFEST_COLLECTION, MANIFEST_RKEY, ciphertext)
  if (!(await hasManifest(nsId))) {
    throw new Error(`channel doc ${nsId} did not retain the manifest entry`)
  }

  const ticket = await publishChannelDocTicket(nsId, kBytes)
  return { nsId, ticket }
}

/** Open (idempotently) the write replica of one of your own channels. */
async function openOwnChannelDoc(
  appKeyHex: string,
  channelID: string,
): Promise<string> {
  await openDocs(appKeyHex)
  const nsSeed = await deriveChannelDocSeed(hexToBytes(appKeyHex), channelID)
  return openChannelDoc(hexOf(nsSeed))
}

/** Whether a channel doc actually holds its manifest entry — the confirmation step
 *  before anything advertises a ticket for it. On web the replica is in-memory, so an
 *  unpopulated doc is the normal state of a fresh page load, not an anomaly. */
async function hasManifest(nsId: string): Promise<boolean> {
  const bytes = await getChannelRecord(nsId, MANIFEST_COLLECTION, MANIFEST_RKEY)
  return !!bytes && bytes.length > 0
}

/** Mint a read ticket for an already-populated channel doc and publish it to the
 *  channel's K-derived pkarr record.
 *
 *  Separate from {@link publishChannelDoc} because it's the part that has to REPEAT: a
 *  ticket freezes whatever addresses are known when it's minted, so one minted before
 *  the endpoint reached a relay carries no dialable address at all (observed — the
 *  first ticket a fresh instance mints is undialable). Re-minting on a cadence is what
 *  keeps a channel reachable, and it costs no Sia object and no manifest rewrite. */
export async function publishChannelDocTicket(
  nsId: string,
  channelKeyBytes: Uint8Array,
): Promise<string> {
  const ticket = await shareChannelDoc(nsId)
  const seed = await deriveChannelDocTicketSeed(channelKeyBytes)
  await (await pkarrTransport()).publish(
    seed,
    chunkForTxt(TICKET_PREFIX, ticket),
  )
  return ticket
}

/** Re-mint and republish the read ticket for a channel this instance already serves.
 *
 *  Refuses to advertise an unpopulated doc. Opening a channel doc CREATES an empty
 *  replica if there isn't one, so on a fresh session (and on web, every page load —
 *  the replica is in-memory) a blind refresh would publish a capability to an empty
 *  doc. Returns whether it published, so the caller can treat "not populated yet" as
 *  work still to do rather than as a failure. */
export async function refreshChannelDocTicket(
  appKeyHex: string,
  channelID: string,
  channelKeyB64: string,
): Promise<boolean> {
  const nsId = await openOwnChannelDoc(appKeyHex, channelID)
  if (!(await hasManifest(nsId))) return false
  await publishChannelDocTicket(nsId, channelKeyFromBase64(channelKeyB64))
  return true
}

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

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
