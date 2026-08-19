// Resolving a portal: turning a repost reference into the post it names.
//
// A portal carries no bytes and no key — only an address — so reading one walks the
// source author's own floor rung, the same one a subscriber walks and the same one that
// works with the author offline:
//
//   did:dht -> `_dir` -> their directory blob -> K for that channel
//           -> the channel's K-derived locator -> the manifest -> the item, by publishedAt
//
// Three DHT resolves and three Sia reads, and none of it needs the author online. Cost
// scales with DISTINCT SOURCES rather than with portal count: ten portals into one
// channel share one directory read and one manifest read, which is what the per-pass
// memo below is for.
//
// ## The directory read is the revocation check
//
// A repost is revocable by the person reposted — un-advertise the channel and every
// portal to it goes dark — and that only holds because K is fetched from their directory
// rather than remembered from when the portal was made. So the directory read can be made
// CHEAP but not skipped: a resolver memoizes it for the length of one pass, and a new pass
// asks again. A cache that outlived the pass would have to stay revalidation-shaped
// (keep K to render, still ask the directory) rather than skip-shaped.
//
// ## Absence has two forms and they are not interchangeable
//
// Reading nothing is never the same as reading that there is nothing — the mistake this
// codebase has made three times (the orphan sweep, the settings wipe, the identity
// publisher). So a failed read is `unreachable` and retryable, while `deleted` and
// `unavailable` are things the network positively said. They differ from each other too:
// a deleted post is permanent, because a re-publish would get a new publishedAt and so a
// new address, where an un-advertised channel can be advertised again.

import type { FeedChannel } from '../core/feed'
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
export function makePortalResolver(client: SiaClient): PortalResolver {
  const directories = new Map<
    string,
    Promise<Awaited<ReturnType<typeof resolveIdentityDoc>> | undefined>
  >()
  const manifests = new Map<string, Promise<ChannelManifest | null>>()

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

      const item = source.items.find(
        (i) => i.publishedAt === target.publishedAt,
      )
      if (!item) return { state: 'deleted' }

      return {
        state: 'resolved',
        item,
        source: {
          channelID: target.channelID,
          channelKey: advertised.key,
          // What their manifest says now, over what the portal cached when it was made.
          name: source.name || advertised.name,
          avatar: source.avatar,
          authorDidDht: target.didDht,
        },
      }
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
