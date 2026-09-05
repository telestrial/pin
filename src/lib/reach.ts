import type { DirectoryDoc } from '../core/identityDoc'
import type { IdentityResolver, ReachFetcher } from '../core/network'
import type { SiaClient } from '../core/siaClient'
import { readDirectory, request } from './directories'
import { resolveIdentityDoc } from './identityDoc'

// Short, readable fallback label for a did:dht with no chosen @-name.
function shortDid(didDht: string): string {
  return `did:dht:…${didDht.replace(/^did:dht:/, '').slice(-6)}`
}

// The three fields a reach walk actually reads out of somebody's directory: who they
// point at, and what to render for them. Narrow on purpose, because it is the shape BOTH
// backings have to produce — a record the crawl holds and a document resolved over the
// network are different types carrying the same answers, and the walk should not know
// which one it got.
type ReachView = {
  profile: { username?: string; avatarURL?: string } | null
  follows: { didDht: string }[]
  handleFollows: string[]
}

// The production reach edges + display resolver, both sharing a per-build memo so each
// person is looked up at most once across the fetch (edges) and resolve (display) passes.
//
// Two backings, preference-ordered — the content-resolution ladder applied to people.
// What the Curator's crawl already holds is read from the doc; anyone it has not reached
// is resolved over the network (pkarr → Sia) exactly as before. Passing no `appKeyHex`
// skips the first rung entirely, which is what the socialGraph harness does.
//
// The rungs are ordered this way rather than the other because the crawl's records are
// both cheaper AND no staler: it writes what it read from the same two sources this
// fallback reads, so preferring the network would spend a DHT lookup and a download to
// learn what is already held.
export function makeReach(
  client: SiaClient,
  appKeyHex?: string,
): {
  fetch: ReachFetcher
  resolve: IdentityResolver
} {
  const memo = new Map<string, Promise<ReachView | null>>()

  const fromDoc = (d: DirectoryDoc): ReachView => ({
    profile: d.profile ?? null,
    follows: d.follows,
    handleFollows: d.handleFollows,
  })

  const view = (didDht: string) => {
    let p = memo.get(didDht)
    if (!p) {
      p = (async () => {
        if (appKeyHex) {
          const held = await readDirectory(appKeyHex, didDht)
          // A minimal record kept only the way back to them — the crawl dropped the edges
          // to make room — so reading it as an answer says this person follows nobody,
          // and a walk would stop at them rather than through them. A reduced record still
          // carries its edges, which is what that tier is FOR, and the profile it lost
          // degrades to a short did: the same fallback as somebody who chose no @-name.
          if (held && held.tier !== 'minimal') {
            return {
              profile: held.profile,
              follows: held.follows,
              handleFollows: held.handleFollows,
            }
          }
          // Nothing asked for a faded one. A record fades because the crawl decided this
          // person is past the horizon, and a transitive hop in a walk is not somebody
          // looking at them — asking would read them back in full only to fade them again,
          // for every walk, forever. A screen that actually renders them still asks.
          if (!held) void request(appKeyHex, didDht)
        }
        // The index could not answer, so this walk is paying a DHT lookup and a download.
        const resolved = await resolveIdentityDoc(client, didDht).catch(
          () => null,
        )
        return resolved ? fromDoc(resolved) : null
      })()
      memo.set(didDht, p)
    }
    return p
  }

  return {
    // A person's public connections: channel-follow authors + handle-follows.
    fetch: async (didDht) => {
      const d = await view(didDht)
      if (!d) return []
      const ids = new Set<string>()
      for (const f of d.follows) ids.add(f.didDht)
      for (const h of d.handleFollows) ids.add(h)
      return [...ids]
    },
    // did:dht → display identity from their profile; handle falls back to a
    // short did so a person is never dropped for lacking a chosen @-name.
    resolve: async (didDht) => {
      const p = (await view(didDht))?.profile
      return {
        handle: p?.username ?? shortDid(didDht),
        username: p?.username,
        avatarURL: p?.avatarURL,
      }
    },
  }
}
