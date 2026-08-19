import { create } from 'zustand'
import {
  buildHomeFeed,
  contributingChannelOf,
  entriesForManifest,
  type FeedEntry,
  type FeedFetchError,
  type FetchChannel,
  portalKey,
  portalsIn,
  type ResolvedPortalEntry,
} from '../core/feed'
import type { ChannelManifest, SubscriptionRef } from '../core/types'
import {
  channelOfSource,
  type PortalOutcome,
  type PortalResolver,
  targetOf,
} from '../lib/repost'

// Channels are read via the locator (pkarr → Sia). That reader needs the Sia
// sdk, so App injects it (useChannelReader) once connected. Until then reads
// can't work anyway — this default just fails loudly rather than falling back
// to atproto. Exported so useChannelReader shares the same identity: refresh
// compares against it to skip the boot-race load (see refresh below).
export const notReady: FetchChannel = () =>
  Promise.reject(new Error('channel reader not initialized'))

// Portals resolved this session, keyed by `portalKey`.
//
// In memory rather than in the doc, deliberately for now: the directory read inside a
// resolve IS the check that a source author still advertises the channel, and that is
// the only reason un-advertising takes a repost down. A cache that outlived the session
// would have to keep asking anyway, so persisting it is a later optimization with its
// own shape rather than a free win.
type PortalCache = Record<string, PortalOutcome>

/** What the collation can actually render: the resolved ones, under the original's
 *  identity. Rebuilt per collation, which is a handful of entries at friend scale. */
function renderable(
  portals: PortalCache,
): Record<string, ResolvedPortalEntry | undefined> {
  const out: Record<string, ResolvedPortalEntry> = {}
  for (const [key, outcome] of Object.entries(portals)) {
    if (outcome.state === 'resolved') {
      out[key] = {
        item: outcome.item,
        channel: channelOfSource(outcome.source),
      }
    }
  }
  return out
}

/** Whether a portal is still worth a read.
 *
 *  A retract is the only final answer: the address is `(author, channel, publishedAt)`
 *  and a re-publish takes a new publishedAt, so nothing will ever appear at that one
 *  again. Everything else can come back — an un-advertised channel can be advertised
 *  again, and an unreachable one is the network rather than an answer — but neither is
 *  re-read here on a timer. They get another chance the next time a pass runs.
 *
 *  A portal already in hand is left alone: re-reading a post that is showing correctly
 *  spends three network round trips to learn nothing. Following the author's edits is
 *  the accelerant rung's job, not this one's. */
function worthAsking(known: PortalOutcome | undefined): boolean {
  return known === undefined || known.state !== 'deleted'
}

type FeedState = {
  entries: FeedEntry[]
  errors: FeedFetchError[]
  manifests: Record<string, ChannelManifest>
  // What each portal in those manifests turned out to be. Read by a row so the owner
  // of a channel can be told which of theirs has gone dead, and by the resolution pass
  // so it knows what is still worth asking about.
  portals: PortalCache
  loading: boolean
  lastRefreshedAt: string | null
  // How channels are read. Defaults to a not-ready reject; App injects the
  // locator reader (pkarr → Sia) once the sdk exists. Pluggable here (not
  // imported) to keep this store off the auth store — auth already imports
  // feed, so the reverse would be a circular import.
  channelReader: FetchChannel
  setChannelReader: (reader: FetchChannel) => void
  // `fresh` bypasses the read cache — pass it for an explicit user Refresh, leave
  // it off for background/boot loads that should take the fast path.
  refresh: (subscriptions: SubscriptionRef[], fresh?: boolean) => Promise<void>
  refreshChannel: (sub: SubscriptionRef, fresh?: boolean) => Promise<void>
  // Read the portals the current manifests name, and re-collate once they answer.
  // Separate from `refresh` because these are reads of OTHER people's channels along
  // their own floor rung, and holding the feed on the slowest stranger would keep every
  // post off the screen.
  resolvePortals: (
    resolver: PortalResolver,
    subscriptions: SubscriptionRef[],
  ) => Promise<void>
  // Reflect a manifest already in hand (e.g. just committed to the locator by
  // the author) — rebuild the channel's entries + cache the manifest, no read.
  applyManifest: (sub: SubscriptionRef, manifest: ChannelManifest) => void
  setManifest: (channelID: string, manifest: ChannelManifest) => void
  removeChannel: (channelID: string) => void
  reset: () => void
}

export const useFeedStore = create<FeedState>()((set, get) => ({
  entries: [],
  errors: [],
  manifests: {},
  portals: {},
  loading: false,
  lastRefreshedAt: null,
  channelReader: notReady,
  setChannelReader: (reader) => set({ channelReader: reader }),
  refresh: async (subscriptions, fresh = false) => {
    // Boot race: on the connect commit HomeFeed's load effect (a child effect)
    // fires before App's useChannelReader (a parent effect) injects the real
    // reader, so channelReader is still the not-ready placeholder here. Skip
    // rather than paint a "channel reader not initialized" error flash —
    // useChannelReader re-runs refresh with the real reader a beat later.
    if (get().channelReader === notReady) return
    set({ loading: true })
    // Pass the current manifests as the stale-while-revalidate fallback so a
    // channel that momentarily fails to re-resolve (DHT lag) keeps its
    // last-known content instead of dropping out of the feed.
    const result = await buildHomeFeed(
      subscriptions,
      get().channelReader,
      get().manifests,
      fresh,
      renderable(get().portals),
    )
    set({
      entries: result.entries,
      errors: result.errors,
      manifests: result.manifests,
      lastRefreshedAt: new Date().toISOString(),
      loading: false,
    })
  },
  refreshChannel: async (sub, fresh = false) => {
    try {
      const manifest = await get().channelReader(
        sub.authorDID || sub.authorHandle,
        sub.channelID,
        sub.channelKey,
        fresh,
      )
      get().applyManifest(sub, manifest)
    } catch (e) {
      console.warn(
        `Failed to refresh channel ${sub.authorHandle}/${sub.channelID}:`,
        e,
      )
    }
  },
  resolvePortals: async (resolver, subscriptions) => {
    const known = get().portals
    const pending = portalsIn(get().manifests).filter((r) =>
      worthAsking(known[portalKey(r)]),
    )
    if (pending.length === 0) return

    const answers = await Promise.all(
      pending.map(async (repost) => {
        const outcome = await resolver.resolve(targetOf(repost))
        return [portalKey(repost), outcome] as const
      }),
    )

    set((s) => {
      const portals = { ...s.portals }
      for (const [key, outcome] of answers) {
        // A failed read never displaces a post already in hand. It says nothing about
        // that post, and letting it clear one would make a slow DHT look to a reader
        // exactly like the author having retracted it.
        if (outcome.state === 'unreachable' && portals[key]) continue
        portals[key] = outcome
      }
      // Collate again: a portal reaches the feed through its channel's manifest, and
      // no manifest has changed — only what its portals turned out to be.
      const shown = renderable(portals)
      const entries = subscriptions.flatMap((sub) => {
        const manifest = s.manifests[sub.channelID]
        return manifest ? entriesForManifest(sub, manifest, shown) : []
      })
      return { portals, entries }
    })
  },
  applyManifest: (sub, manifest) =>
    set((s) => {
      // What this channel contributed, which for a portal is the channel circulating
      // it rather than the one that wrote it. Matching on `e.channel` would leave a
      // portal behind as a duplicate every time its channel updated.
      const others = s.entries.filter((e) => {
        const from = contributingChannelOf(e)
        return !(
          from.authorHandle === sub.authorHandle &&
          from.channelID === sub.channelID
        )
      })
      const fresh = entriesForManifest(sub, manifest, renderable(s.portals))
      return {
        entries: [...others, ...fresh],
        manifests: { ...s.manifests, [sub.channelID]: manifest },
      }
    }),
  setManifest: (channelID, manifest) =>
    set((s) => ({
      manifests: { ...s.manifests, [channelID]: manifest },
    })),
  removeChannel: (channelID) =>
    set((s) => {
      const { [channelID]: _, ...remainingManifests } = s.manifests
      return {
        // What this channel contributed. A portal in some OTHER channel that happens to
        // point at this one stays: it is reachable through the author's directory, not
        // through a subscription this identity just dropped.
        entries: s.entries.filter(
          (e) => contributingChannelOf(e).channelID !== channelID,
        ),
        errors: s.errors.filter((e) => e.channelID !== channelID),
        manifests: remainingManifests,
      }
    }),
  reset: () =>
    set({
      entries: [],
      errors: [],
      manifests: {},
      portals: {},
      loading: false,
      lastRefreshedAt: null,
    }),
}))
