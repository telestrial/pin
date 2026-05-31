import { CHANNEL_MANIFEST_VERSION } from '../core/types'
import type { ChannelManifest, ItemRef, SubscriptionRef } from '../core/types'

// A purely synthetic social graph for testing reachability and discovery.
// No SDK, no network, no real DIDs — just JS objects shaped like what
// production expects, generated deterministically so tests can assert
// without coupling to runtime state.
//
// The graph mirrors production identity: users own channels; each channel
// has a manifest with items; subscriptions live on the reader side.
// Cryptographic identity (sha256-derived channelIDs, AppKeys, etc.) is
// replaced with deterministic synthetic strings — the harness is about
// graph topology and reachability, not crypto fidelity.

export type SyntheticUser = {
  did: string
  handle: string
  channels: SyntheticChannel[]
  subscriptions: SubscriptionRef[]
}

export type SyntheticChannel = {
  channelID: string
  channelKey: string
  ownerDID: string
  ownerHandle: string
  manifest: ChannelManifest
}

export type SyntheticGraph = {
  users: SyntheticUser[]
}

const FIXED_TIME = '2026-05-30T12:00:00.000Z'

function syntheticDID(handle: string): string {
  return `did:test:${handle}`
}

function syntheticChannelID(handle: string, name: string): string {
  return `${handle}-${name}`
}

function syntheticChannelKey(handle: string, name: string): string {
  return `key_${handle}_${name}`
}

function syntheticItemID(channelID: string, body: string): string {
  return `${channelID}_${body.slice(0, 20).replace(/\s+/g, '_')}`
}

export type GraphBuilder = {
  addUser: (handle: string) => GraphBuilder
  addChannel: (
    ownerHandle: string,
    name: string,
    description?: string,
  ) => GraphBuilder
  publish: (
    ownerHandle: string,
    channelName: string,
    body: string,
    title?: string,
  ) => GraphBuilder
  subscribe: (
    viewerHandle: string,
    ownerHandle: string,
    channelName: string,
  ) => GraphBuilder
  build: () => SyntheticGraph
}

// Chainable builder. Throws on referential errors (unknown user, unknown
// channel) — these are programming mistakes in test setup, not runtime
// concerns.
export function buildGraph(): GraphBuilder {
  const usersByHandle = new Map<string, SyntheticUser>()
  // Shared monotonic clock — every publish across the whole builder gets
  // a unique, ordered timestamp so newest-first sorts are deterministic.
  let publishCounter = 0

  function userOrThrow(handle: string): SyntheticUser {
    const u = usersByHandle.get(handle)
    if (!u) throw new Error(`Synthetic user '${handle}' not found`)
    return u
  }

  function channelOrThrow(
    user: SyntheticUser,
    channelName: string,
  ): SyntheticChannel {
    const channelID = syntheticChannelID(user.handle, channelName)
    const c = user.channels.find((c) => c.channelID === channelID)
    if (!c) {
      throw new Error(`Channel '${user.handle}/${channelName}' not found`)
    }
    return c
  }

  const builder: GraphBuilder = {
    addUser: (handle) => {
      if (usersByHandle.has(handle)) {
        throw new Error(`Duplicate user '${handle}'`)
      }
      usersByHandle.set(handle, {
        did: syntheticDID(handle),
        handle,
        channels: [],
        subscriptions: [],
      })
      return builder
    },
    addChannel: (ownerHandle, name, description = '') => {
      const owner = userOrThrow(ownerHandle)
      const channelID = syntheticChannelID(ownerHandle, name)
      if (owner.channels.some((c) => c.channelID === channelID)) {
        throw new Error(`Duplicate channel '${ownerHandle}/${name}'`)
      }
      const manifest: ChannelManifest = {
        version: CHANNEL_MANIFEST_VERSION,
        name,
        description,
        authorPubkey: `pubkey_${ownerHandle}`,
        authorATProtoDID: owner.did,
        publishedAt: FIXED_TIME,
        items: [],
      }
      owner.channels.push({
        channelID,
        channelKey: syntheticChannelKey(ownerHandle, name),
        ownerDID: owner.did,
        ownerHandle,
        manifest,
      })
      return builder
    },
    publish: (ownerHandle, channelName, body, title = '') => {
      const owner = userOrThrow(ownerHandle)
      const channel = channelOrThrow(owner, channelName)
      const publishedAt = new Date(
        new Date(FIXED_TIME).getTime() + publishCounter * 60_000,
      ).toISOString()
      publishCounter++
      const item: ItemRef = {
        id: syntheticItemID(channel.channelID, body),
        itemURL: `synthetic://${channel.channelID}/${body.slice(0, 16)}`,
        type: 'text',
        title,
        summary: body,
        publishedAt,
        mimeType: 'text/markdown',
        byteSize: new TextEncoder().encode(body).length,
      }
      // Newest-first, matching production ChannelManifest.items convention.
      channel.manifest.items.unshift(item)
      return builder
    },
    subscribe: (viewerHandle, ownerHandle, channelName) => {
      const viewer = userOrThrow(viewerHandle)
      const owner = userOrThrow(ownerHandle)
      const channel = channelOrThrow(owner, channelName)
      if (
        viewer.subscriptions.some((s) => s.channelID === channel.channelID)
      ) {
        return builder
      }
      viewer.subscriptions.push({
        authorHandle: owner.handle,
        authorDID: owner.did,
        channelID: channel.channelID,
        channelKey: channel.channelKey,
        cachedName: channel.manifest.name,
        addedAt: FIXED_TIME,
      })
      return builder
    },
    build: () => ({ users: [...usersByHandle.values()] }),
  }

  return builder
}

// Reachability rule R0: "things in channels you directly subscribe to."
// Doesn't include the viewer's own channels — those are a separate corpus
// ("your stuff"), not part of "people you follow's stuff." Adding own
// channels for a richer search surface is a different rule, not a tweak.
export function reachableChannels(
  viewerDID: string,
  graph: SyntheticGraph,
): SyntheticChannel[] {
  const viewer = graph.users.find((u) => u.did === viewerDID)
  if (!viewer) return []

  const result: SyntheticChannel[] = []
  for (const sub of viewer.subscriptions) {
    const owner = graph.users.find((u) => u.did === sub.authorDID)
    if (!owner) continue
    const channel = owner.channels.find((c) => c.channelID === sub.channelID)
    if (channel) result.push(channel)
  }
  return result
}

export type SearchMatch = 'title' | 'body' | 'channelName'

export type SearchResult = {
  channel: SyntheticChannel
  item: ItemRef
  matched: SearchMatch
}

// Search the viewer's reachable corpus by case-insensitive substring.
// Per-item precedence: title > body > channelName. Sorted newest-first.
export function search(
  viewerDID: string,
  query: string,
  graph: SyntheticGraph,
): SearchResult[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []

  const results: SearchResult[] = []
  for (const channel of reachableChannels(viewerDID, graph)) {
    const channelMatches = channel.manifest.name.toLowerCase().includes(q)
    for (const item of channel.manifest.items) {
      if (item.title.toLowerCase().includes(q)) {
        results.push({ channel, item, matched: 'title' })
      } else if (item.summary?.toLowerCase().includes(q)) {
        results.push({ channel, item, matched: 'body' })
      } else if (channelMatches) {
        results.push({ channel, item, matched: 'channelName' })
      }
    }
  }
  results.sort((a, b) => b.item.publishedAt.localeCompare(a.item.publishedAt))
  return results
}

// Deterministic PRNG so scaled graphs reproduce across runs. mulberry32
// — small, fast, sufficient for fixture generation (not crypto).
function mulberry32(seed: number): () => number {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Body template uses "Post about <keyword>..." so every item contains the
// literal "post" regardless of which keyword landed. Tests can use "post"
// as a universal query whose reach is mathematically known
// (subscriptionsPerUser × itemsPerChannel for a successfully-subscribed
// viewer), or pick a specific keyword for partial-reach assertions.
const KEYWORD_POOL = ['cats', 'rust', 'coffee', 'music', 'running']

export type ScaledGraphSpec = {
  userCount: number
  channelsPerUser: number
  itemsPerChannel: number
  subscriptionsPerUser: number
  seed: number
}

// Generator for scaled graphs above STANDARD_GRAPH. Users named user0..userN,
// channels ch0..chM. Subscriptions are uniform random (no power-law yet —
// that's a later fixture concern). Self-subscriptions and duplicate
// (user, channel) pairs are skipped via a bounded retry loop; viewers
// may end up with slightly fewer than spec.subscriptionsPerUser subs in
// dense small graphs, but the variance is negligible at the scales used
// for tripwires.
export function buildScaledGraph(spec: ScaledGraphSpec): SyntheticGraph {
  const rand = mulberry32(spec.seed)
  const builder = buildGraph()

  for (let i = 0; i < spec.userCount; i++) {
    builder.addUser(`user${i}`)
  }
  for (let i = 0; i < spec.userCount; i++) {
    for (let c = 0; c < spec.channelsPerUser; c++) {
      builder.addChannel(`user${i}`, `ch${c}`)
    }
  }
  for (let i = 0; i < spec.userCount; i++) {
    for (let c = 0; c < spec.channelsPerUser; c++) {
      for (let it = 0; it < spec.itemsPerChannel; it++) {
        const keyword =
          KEYWORD_POOL[Math.floor(rand() * KEYWORD_POOL.length)]!
        builder.publish(
          `user${i}`,
          `ch${c}`,
          `Post about ${keyword} number ${it}.`,
        )
      }
    }
  }
  for (let i = 0; i < spec.userCount; i++) {
    const claimed = new Set<string>()
    const maxAttempts = spec.subscriptionsPerUser * 5
    let attempts = 0
    while (
      claimed.size < spec.subscriptionsPerUser &&
      attempts < maxAttempts
    ) {
      attempts++
      const targetUser = Math.floor(rand() * spec.userCount)
      if (targetUser === i) continue
      const targetChannel = Math.floor(rand() * spec.channelsPerUser)
      const key = `${targetUser}:${targetChannel}`
      if (claimed.has(key)) continue
      claimed.add(key)
      builder.subscribe(`user${i}`, `user${targetUser}`, `ch${targetChannel}`)
    }
  }

  return builder.build()
}

// Standard fixture. Five users, content seeded with predictable keywords
// (cats, rust, coffee) so test assertions stay legible. Subscription
// topology produces useful cases: alice sees pets+rust (not coffee, not
// eve's hidden channel); eve sees nothing; dan and alice's reaches
// overlap on carol/rust.
export const STANDARD_GRAPH: SyntheticGraph = buildGraph()
  .addUser('alice')
  .addUser('bob')
  .addUser('carol')
  .addUser('dan')
  .addUser('eve')

  .addChannel('alice', 'daily', 'Daily musings')
  .publish('alice', 'daily', 'Running every morning has changed me.')
  .publish('alice', 'daily', 'Weather is wild today.')

  .addChannel('bob', 'pets', "Bob's animals")
  .publish('bob', 'pets', 'Cats are wonderful creatures.', 'On cats')
  .publish('bob', 'pets', 'Dogs are good too.')
  .publish('bob', 'pets', 'My cat slept on my keyboard again.')

  .addChannel('carol', 'rust', 'Rust notes')
  .publish(
    'carol',
    'rust',
    'The borrow checker is your friend, eventually.',
    'Borrow checker',
  )
  .publish('carol', 'rust', 'Lifetimes deserve more love.')

  .addChannel('carol', 'coffee', "Carol's coffee log")
  .publish('carol', 'coffee', 'Espresso pull this morning was perfect.')

  .addChannel('dan', 'coffee', "Dan's morning brews")
  .publish('dan', 'coffee', 'Pour over with a v60.')
  .publish('dan', 'coffee', 'Trying a new bean roaster.')

  .addChannel('eve', 'hidden', 'Eve writes alone')
  .publish('eve', 'hidden', 'The secret to peace is not subscribing.')

  .subscribe('alice', 'bob', 'pets')
  .subscribe('alice', 'carol', 'rust')
  .subscribe('bob', 'alice', 'daily')
  .subscribe('carol', 'dan', 'coffee')
  .subscribe('dan', 'alice', 'daily')
  .subscribe('dan', 'carol', 'rust')

  .build()

// +1 order of magnitude above STANDARD_GRAPH (5 users → 50). 1000 items
// total across 100 channels; user0 has 5 subs → ~50 reachable items.
export const MEDIUM_GRAPH: SyntheticGraph = buildScaledGraph({
  userCount: 50,
  channelsPerUser: 2,
  itemsPerChannel: 10,
  subscriptionsPerUser: 5,
  seed: 42,
})

// +2 orders of magnitude above STANDARD_GRAPH (5 → 500). 10,000 items
// total across 1000 channels; user0 has 10 subs → ~100 reachable items.
export const LARGE_GRAPH: SyntheticGraph = buildScaledGraph({
  userCount: 500,
  channelsPerUser: 2,
  itemsPerChannel: 10,
  subscriptionsPerUser: 10,
  seed: 42,
})
