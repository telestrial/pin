// Resolving a portal: turning a repost reference into the post it names.
//
// A portal carries no bytes and no key — only an address — so reading one has to find K
// first. Two ways, and the order matters:
//
//   1. WHAT THE READER ALREADY HOLDS. Subscribed to that channel, or its owner? Then K is
//      in hand and usually the manifest is too, and the answer needs no network at all.
//   2. THE AUTHOR'S OWN FLOOR RUNG, for a channel this identity has no relationship with:
//        did:dht -> `_dir` -> their directory blob -> K
//                -> the channel's K-derived locator -> the manifest -> the item
//
// Rung 2 is three DHT resolves and three Sia reads, and none of it needs the author
// online. Cost there scales with DISTINCT SOURCES rather than with portal count — ten
// portals into one channel share one directory read and one manifest read, which is what
// the per-pass memo below is for.
//
// ## Why holding K comes first, and what that means for revocation
//
// A repost is revocable by the person reposted: un-advertise the channel and every portal
// to it goes dark. That works because rung 2 fetches K from their directory rather than
// remembering it from when the portal was made — so the directory read is the revocation
// check, can be made cheap, and must not be cached away. A cache that outlived a pass
// would have to stay revalidation-shaped (keep K to render, still ask the directory)
// rather than skip-shaped.
//
// But it revokes DISCOVERY, not access to somebody already holding K. A subscriber was
// given the key and can read the channel whether or not it is still advertised, so asking
// the author's directory about a channel this reader is subscribed to answers the wrong
// question — and answers it wrongly, since a directory that is merely stale would report
// a post the reader can plainly see as unavailable. Hence rung 1, which is also why a
// portal to your OWN post resolves with no network at all.
//
// ## Counts come from the same rung the post did
//
// A row's counts are read from this identity's own doc, and what fills that cache is a
// pass over a channel it has a relationship with — the pull loop for a subscription, the
// engagement loop for one it owns. A portal into a stranger's channel has neither, so
// nothing would ever write counts for it and the row would render bare beside a post that
// plainly has them. Rung 2 is therefore also where the channel's published counts get
// cached, for exactly the reason it is where the manifest gets read: no pass covers this
// channel, so this read is the only one there is.
//
// ## Absence has two forms and they are not interchangeable
//
// Reading nothing is never the same as reading that there is nothing — the mistake this
// codebase has made three times (the orphan sweep, the settings wipe, the identity
// publisher). So a failed read is `unreachable` and retryable, while `deleted` and
// `unavailable` are things the network positively said. They differ from each other too:
// a deleted post is permanent, because a re-publish would get a new publishedAt and so a
// new address, where an un-advertised channel can be advertised again.

import type { FeedChannel, FeedEntry } from '../core/feed'
import type { SiaClient } from '../core/siaClient'
import type {
  ChannelImage,
  ChannelManifest,
  ItemRef,
  RepostRef,
} from '../core/types'
import { resolveChannelViaLocator } from './channelLocator'
import { resolveIdentityDoc } from './identityDoc'

/** The post a portal names. Just the address — the parts of a `RepostRef` that identify
 *  the source, without the parts that are about this copy of it. */
export type PortalTarget = {
  didDht: string
  channelID: string
  publishedAt: string
}

/** What the source channel turned out to be, for a portal that resolved. Enough to render
 *  the post under its ORIGINAL identity, which is whose name a portal shows. */
export type PortalSource = {
  channelID: string
  channelKey: string
  name: string
  avatar?: ChannelImage
  authorDidDht: string
}

export type PortalOutcome =
  /** The post is there. */
  | { state: 'resolved'; item: ItemRef; source: PortalSource }
  /** Their channel was read and this post is not in it: the author retracted it.
   *  PERMANENT — a re-publish takes a new publishedAt, so nothing will ever appear at
   *  this address again. A reader shows nothing; the owner is offered a dismiss. */
  | { state: 'deleted' }
  /** Their directory was read and no longer advertises this channel: access withdrawn
   *  rather than content retracted. Retryable, because advertising is reversible. */
  | { state: 'unavailable' }
  /** Nothing could be read — their directory or the channel's pointer didn't answer.
   *  Says nothing about whether the post exists. Retryable. */
  | { state: 'unreachable' }

/** Whether a portal's outcome will ever change on its own. Only a retract is final; the
 *  other two are the network being unreadable or an author being un-advertised, and both
 *  can come back. */
export function isPermanent(outcome: PortalOutcome): boolean {
  return outcome.state === 'deleted'
}

/** The address part of a portal, dropping what is about this copy of it. */
export function targetOf(repost: RepostRef): PortalTarget {
  return {
    didDht: repost.didDht,
    channelID: repost.channelID,
    publishedAt: repost.publishedAt,
  }
}

/** A channel this identity already has a relationship with: subscribed to it, or its
 *  owner. Both mean K was handed over, which is the whole of what rung 2 goes looking
 *  for. */
export type HeldChannel = {
  channelKey: string
  /** The manifest already in hand, when there is one. Present for anything the feed has
   *  loaded, which makes the read free rather than merely cheap. */
  manifest?: ChannelManifest
}

/** What this identity holds for a portal's source, or null when it holds nothing.
 *
 *  Injected rather than read from the stores here, so this module stays testable and off
 *  the store graph — the same seam `FetchChannel` uses. */
export type HeldChannels = (target: PortalTarget) => HeldChannel | null

/** Cache one source channel's published counts, so a portal row shows the numbers a
 *  subscriber's row shows.
 *
 *  Injected for the same reason `held` is, and called only from rung 2: a channel this
 *  identity already holds has its counts on the way through the ordinary subscribed path,
 *  so warming there would spend a DHT resolve and a Sia read on work already done. */
export type WarmTallies = (channelID: string, channelKey: string) => void

export type PortalResolver = {
  resolve: (target: PortalTarget) => Promise<PortalOutcome>
}

/** A resolver for one pass over some portals.
 *
 *  The memos live on the resolver rather than in the module, so their lifetime is the
 *  caller's and is obvious from the call site: a feed build makes one, uses it for every
 *  portal in the feed, and drops it. Nothing persists, so the next pass asks the network
 *  again — which is what keeps the directory read doing its job as the revocation check.
 *
 *  Promises are memoized rather than results, so two portals into one channel resolved
 *  concurrently share the one read instead of racing two. */
export function makePortalResolver(
  client: SiaClient,
  held: HeldChannels = () => null,
  warm: WarmTallies = () => {},
): PortalResolver {
  const directories = new Map<
    string,
    Promise<Awaited<ReturnType<typeof resolveIdentityDoc>> | undefined>
  >()
  const manifests = new Map<string, Promise<ChannelManifest | null>>()
  // Counts are per channel rather than per post, so ten portals into one source want one
  // read of them — the same amortization the two memos above are for.
  const warmed = new Set<string>()

  // undefined = the read failed (unreachable); null = read fine, nothing published.
  const directory = (didDht: string) => {
    let p = directories.get(didDht)
    if (!p) {
      p = resolveIdentityDoc(client, didDht).catch(() => undefined)
      directories.set(didDht, p)
    }
    return p
  }

  const manifest = (channelKey: string) => {
    let p = manifests.get(channelKey)
    if (!p) {
      p = resolveChannelViaLocator(channelKey).catch(() => null)
      manifests.set(channelKey, p)
    }
    return p
  }

  return {
    async resolve(target: PortalTarget): Promise<PortalOutcome> {
      // Rung 1: already holding K. Never `unavailable` from here — that state means the
      // author is not sharing this channel with us, and they demonstrably are.
      const mine = held(target)
      if (mine) {
        const source = mine.manifest ?? (await manifest(mine.channelKey))
        if (!source) return { state: 'unreachable' }
        return found(target, source, mine.channelKey)
      }

      // Rung 2: no relationship with this channel, so ask its author.
      const doc = await directory(target.didDht)
      // Unread and read-as-absent are the same to us here: a directory that is missing
      // entirely is the author unreachable, not the author saying anything.
      if (!doc) return { state: 'unreachable' }

      const advertised = doc.channels.find(
        (c) => c.channelID === target.channelID,
      )
      if (!advertised) return { state: 'unavailable' }

      const source = await manifest(advertised.key)
      // A pointer that does not answer says nothing about the post. Propagation lag on
      // the DHT looks exactly like this, so it must not read as a retract.
      if (!source) return { state: 'unreachable' }

      const outcome = found(target, source, advertised.key, advertised.name)
      // Only for a portal that resolved: the other outcomes have no row to put numbers
      // beside, and a channel that could not be read is not one to go asking about.
      if (outcome.state === 'resolved' && !warmed.has(target.channelID)) {
        warmed.add(target.channelID)
        warm(target.channelID, advertised.key)
      }
      return outcome
    },
  }
}

/** The item a portal names inside a manifest now in hand, or the news that it is gone.
 *
 *  Shared by both rungs, because from here they are the same question and answering it
 *  twice is how they would come to differ. */
function found(
  target: PortalTarget,
  source: ChannelManifest,
  channelKey: string,
  advertisedName?: string,
): PortalOutcome {
  const item = source.items.find((i) => i.publishedAt === target.publishedAt)
  if (!item) return { state: 'deleted' }
  return {
    state: 'resolved',
    item,
    source: {
      channelID: target.channelID,
      channelKey,
      // What their manifest says now, over what a directory or a portal cached earlier.
      name: source.name || advertisedName || '',
      avatar: source.avatar,
      authorDidDht: target.didDht,
    },
  }
}

/** A resolved source, as the feed presents it. A portal shows the post under the
 *  ORIGINAL channel's identity, and that identity is did:dht-native — the source is
 *  reached through their directory, which has no atproto handle in it. Empty handle is
 *  what a did:dht subscription already carries, so a portal row and a subscribed row
 *  render through the same path. */
export function channelOfSource(source: PortalSource): FeedChannel {
  return {
    authorHandle: '',
    authorDidDht: source.authorDidDht,
    channelID: source.channelID,
    name: source.name,
    avatar: source.avatar,
  }
}

/** The address to circulate for a post shown in the feed, or null when it cannot be
 *  circulated.
 *
 *  Two conditions, and the second is the interesting one.
 *
 *  The source author has to be NAMED, because a portal is `(didDht, channelID,
 *  publishedAt)` and there is nothing to point at without the first. A pre-did:dht
 *  channel carries no such name.
 *
 *  And the source channel has to be PUBLIC. Reposting out of an unlisted channel would
 *  publish its existence to the reposter's subscribers, which is the one property that
 *  tier has — and it would not work anyway, since the portal's read capability comes from
 *  the author's directory and an unlisted channel is deliberately not in it. Twitter and
 *  Mastodon both refuse the same thing for the same reason. So the refusal is honest
 *  rather than enforced: hiding the gesture says out loud what the mechanism would do
 *  silently.
 *
 *  A post ALREADY reaching the feed through a portal is public by construction — it was
 *  read out of an author's directory, and only public channels are advertised there. That
 *  is also why reposting a repost points at the original: an entry's `channel` is whose
 *  post it is, never who passed it along, so the address never accumulates a chain.
 *
 *  Unknown reads as no. Being unable to tell whether a channel is unlisted is not a
 *  reason to treat it as public. */
export function repostTargetFor(
  entry: FeedEntry,
  manifests: Readonly<Record<string, ChannelManifest | undefined>>,
): PortalTarget | null {
  const { authorDidDht, channelID } = entry.channel
  if (!authorDidDht) return null

  const advertised = entry.repost !== undefined
  const known = manifests[channelID]
  if (!advertised && known?.visibility !== 'public') return null

  return {
    didDht: authorDidDht,
    channelID,
    publishedAt: entry.item.publishedAt,
  }
}
