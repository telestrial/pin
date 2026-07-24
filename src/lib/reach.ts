import type { DirectoryDoc } from '../core/identityDoc'
import type { IdentityResolver, ReachFetcher } from '../core/network'
import type { SiaClient } from '../core/siaClient'
import { resolveIdentityDoc } from './identityDoc'

// Short, readable fallback label for a did:dht with no chosen @-name.
function shortDid(didDht: string): string {
  return `did:dht:…${didDht.replace(/^did:dht:/, '').slice(-6)}`
}

// The production reach edges + display resolver, both backed by identity-doc
// resolution (pkarr → Sia) and sharing a per-build memo so each person's doc is
// fetched at most once across the fetch (edges) and resolve (display) passes.
export function makeReach(client: SiaClient): {
  fetch: ReachFetcher
  resolve: IdentityResolver
} {
  const memo = new Map<string, Promise<DirectoryDoc | null>>()
  const doc = (didDht: string) => {
    let p = memo.get(didDht)
    if (!p) {
      p = resolveIdentityDoc(client, didDht).catch(() => null)
      memo.set(didDht, p)
    }
    return p
  }

  return {
    // A person's public connections: channel-follow authors + handle-follows.
    fetch: async (didDht) => {
      const d = await doc(didDht)
      if (!d) return []
      const ids = new Set<string>()
      for (const f of d.follows) ids.add(f.didDht)
      for (const h of d.handleFollows) ids.add(h)
      return [...ids]
    },
    // did:dht → display identity from their profile; handle falls back to a
    // short did so a person is never dropped for lacking a chosen @-name.
    resolve: async (didDht) => {
      const p = (await doc(didDht))?.profile
      return {
        handle: p?.username ?? shortDid(didDht),
        username: p?.username,
        avatarURL: p?.avatarURL,
      }
    },
  }
}
