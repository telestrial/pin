// Reading the portals the feed is currently carrying.
//
// Separate from the feed's own load because it is a different kind of read: a channel
// resolves through a subscription this identity already holds, where a portal walks a
// STRANGER's floor rung — their directory, their channel's locator, their manifest. Three
// DHT resolves and three Sia reads per source, and holding the feed on the slowest of
// them would keep every post off the screen until it answered.
//
// So the feed paints first with what it has, and reposts fill in behind it. A portal that
// has not answered yet shows nothing, which is also what a reader sees for one that came
// back deleted or unavailable — the distinction only matters to the channel's owner, who
// is the only one who can act on it.

import { useEffect, useRef } from 'react'
import { portalsIn } from '../../core/feed'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { makePortalResolver } from '../repost'

export function usePortalResolution() {
  const client = useAuthStore((s) => s.client)
  const manifests = useFeedStore((s) => s.manifests)
  // A pass in flight, and whether the world moved while it ran. Without the second
  // flag a manifest arriving mid-pass would wait for whatever changes next, which for
  // a channel that has stopped posting is never.
  const running = useRef(false)
  const again = useRef(false)

  // The portals the feed names, as one string. Depending on `manifests` directly would
  // re-run on every manifest write — a repack rewriting URLs, a background revalidate
  // finding nothing changed — none of which alters what there is to resolve.
  const wanted = portalsIn(manifests)
    .map((r) => `${r.didDht}/${r.channelID}/${r.publishedAt}`)
    .sort()
    .join(',')

  useEffect(() => {
    if (!client || wanted === '') return
    let cancelled = false

    const pass = async () => {
      if (running.current) {
        again.current = true
        return
      }
      running.current = true
      try {
        do {
          again.current = false
          // A fresh resolver per pass, so its memo lives exactly as long as the pass.
          // That memo is what makes ten portals into one channel cost one directory
          // read; keeping it any longer would start skipping the directory read that
          // tells us whether the author still advertises the channel at all.
          const resolver = makePortalResolver(client)
          const subs = useAuthStore.getState().subscriptions
          await useFeedStore.getState().resolvePortals(resolver, subs)
        } while (again.current && !cancelled)
      } catch (e) {
        // Nothing here is load-bearing for the rest of the feed: the posts are already
        // painted, and an unresolved portal renders as nothing.
        console.warn('portal resolution pass failed:', e)
      } finally {
        running.current = false
      }
    }

    void pass()
    return () => {
      cancelled = true
    }
  }, [client, wanted])
}
