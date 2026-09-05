// What this identity knows about other identities, as a screen reads it.
//
// A profile is a server: a did:dht with published endpoints, a directory blob naming the
// channels it advertises, and follows pointing at further servers. The Curator's crawl
// records one of these per identity it has read, out of a resolve and a download it was
// already making for engagement — so by the time a screen asks, the answer is usually a
// doc read rather than a DHT lookup and a Sia download.
//
// Read-only from here. The crawl is the sole writer, which is what keeps one address from
// having two spellings and what makes "the repo is the only contract" true in this
// direction: the Curator writes, the frontend reads.

import {
  directory_collection,
  request_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import { getRecord, listRecords, openDocs, putRecord } from './docs'

/** One channel an identity advertises, as their directory publishes it.
 *
 *  Carries `key` — a public channel advertises its K, which is what makes it readable to
 *  whoever holds this record. An unlisted channel is absent from a directory by
 *  construction, so nothing here can name one. */
export type DirectoryChannel = {
  channelID: string
  key: string
  name: string
}

/** Where an identity can be dialed: an endpoint, and the relay it is reachable through.
 *
 *  `relay` is absent when the endpoint named itself without saying where it is — ordinary
 *  right after a bind. A peer skips such an endpoint, so an identity whose every entry
 *  lacks one is published but not currently reachable. */
export type DirectoryReach = {
  nodeID: string
  relay?: string
}

/** Their self-asserted profile. Every field optional and none of it structural: identity
 *  is the DID, so a name here is a display label carrying no weight. */
export type DirectoryProfile = {
  username?: string
  displayName?: string
  bio?: string
  avatarURL?: string
  coverURL?: string
}

/** Everything one read of another identity's directory yielded.
 *
 *  `seenAt` is when this last CHANGED, not when it was last looked at — the crawl rewrites
 *  a record only when its substance moved, so an identity that is alive but has published
 *  nothing keeps an old stamp. That is the honest reading: it says how old what we hold
 *  is. */
/** How much of an identity is still kept.
 *
 *  Nothing is ever deleted: the far network fades rather than disappearing, so what is
 *  always left is the DID and where they were last reachable. A reduced record has lost its
 *  profile and channels; a minimal one has lost its edges too. */
export type DirectoryTier = 'full' | 'reduced' | 'minimal'

export type DirectoryRecord = {
  tier: DirectoryTier
  profile: DirectoryProfile | null
  channels: DirectoryChannel[]
  reach: DirectoryReach[]
  follows: { didDht: string; channelID: string; name?: string }[]
  handleFollows: string[]
  url: string
  epoch: number
  seenAt: string
}

/** What this identity holds about `didDht`, or null when the crawl has never read them.
 *
 *  Null is ordinary rather than an error: it means they are unresolved — possibly known
 *  to exist because somebody we hold follows them, possibly not known at all. Either way
 *  the caller's fallback is the network, and asking is what requests them to be read. */
export async function readDirectory(
  appKeyHex: string,
  didDht: string,
): Promise<DirectoryRecord | null> {
  try {
    await openDocs(appKeyHex)
    await ensureWasm()
    const stored = await getRecord(directory_collection(), didDht)
    if (!stored) return null
    return JSON.parse(new TextDecoder().decode(stored)) as DirectoryRecord
  } catch {
    // A doc that won't open or a record that won't parse reads as "not held", which is
    // the same branch a caller takes for anyone never crawled. Nothing about a cached
    // profile is worth failing a render over.
    return null
  }
}

/** Ask the crawl to read someone, because a screen needed them and the index had nothing.
 *
 *  The one input to the crawl's order that does not come from the graph: everything else
 *  it decides is a guess about who is worth reading, and this is somebody actually asking.
 *  So it sorts ahead of all of it, and the Curator clears the request once the answer is
 *  held.
 *
 *  Best-effort and unawaited by its callers. A lost request costs a few passes of
 *  priority — the person is still reachable over the network this session, and still on
 *  the frontier if anybody points at them.
 *
 *  Silent when one already stands: every write to this doc is announced to every syncing
 *  instance and is a reason to mirror the whole doc to Sia, so a feed re-rendering the
 *  same unresolved person must not cost a write per render. */
export async function request(
  appKeyHex: string,
  didDht: string,
): Promise<void> {
  try {
    await openDocs(appKeyHex)
    await ensureWasm()
    const collection = request_collection()
    if (await getRecord(collection, didDht)) return
    await putRecord(
      collection,
      didDht,
      new TextEncoder().encode(
        JSON.stringify({ at: new Date().toISOString() }),
      ),
    )
  } catch {
    // Asking is an optimization on top of a fallback that already worked. Nothing about
    // it is worth failing a render over.
  }
}

/** Every identity the crawl has read, by did:dht.
 *
 *  Backed by a prefix scan over the whole doc, so this is for building an index — search,
 *  a reach walk, the frontier — rather than for rendering one row. A row wants
 *  {@link readDirectory}. */
export async function listDirectoryDids(appKeyHex: string): Promise<string[]> {
  try {
    await openDocs(appKeyHex)
    await ensureWasm()
    return await listRecords(directory_collection())
  } catch {
    return []
  }
}

/** Every held directory, with the did each is filed under.
 *
 *  One read per identity, so the cost is the size of what has been crawled. A record that
 *  won't parse is skipped rather than failing the set: one bad entry must not cost a
 *  caller the whole index. */
export async function listDirectories(
  appKeyHex: string,
): Promise<{ didDht: string; record: DirectoryRecord }[]> {
  const dids = await listDirectoryDids(appKeyHex)
  const held = await Promise.all(
    dids.map(async (didDht) => {
      const record = await readDirectory(appKeyHex, didDht)
      return record ? { didDht, record } : null
    }),
  )
  return held.filter(
    (h): h is { didDht: string; record: DirectoryRecord } => h !== null,
  )
}
