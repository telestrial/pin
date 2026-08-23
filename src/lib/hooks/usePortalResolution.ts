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
//
// A source's published counts are cached on the way past, for the same reason its manifest
// is read here: no loop covers a channel this identity has no relationship with, so this
// pass is what puts numbers beside a portal's row.

import { useEffect, useRef } from 'react'
import { portalsIn } from '../../core/feed'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { warmChannelConversations } from '../channelConversations'
import { warmChannelTallies } from '../channelTallies'
import { type HeldChannels, makePortalResolver } from '../repost'

/** What this identity already holds for a portal's source: K, and the manifest when the
 *  feed has one.
 *
 *  A subscription or ownership both mean the key was handed over, which is the whole of
 *  what a directory read goes looking for — so a portal into a channel this reader already
 *  follows needs no network, and cannot be reported as unavailable by a directory that has
 *  merely gone stale. */
function heldChannels(): HeldChannels {
  const auth = useAuthStore.getState()
  const manifests = useFeedStore.getState().manifests
  return ({ channelID }) => {
    const key =
      auth.subscriptions.find((s) => s.channelID === channelID)?.channelKey ??
      auth.myChannels.find((c) => c.channelID === channelID)?.channelKey
    if (!key) return null
    return { channelKey: key, manifest: manifests[channelID] }
  }
}

export function usePortalResolution() {
  const client = useAuthStore((s) => s.client)
  const appKeyHex = useAuthStore((s) => s.storedKeyHex)
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
          const resolver = makePortalResolver(
            client,
            heldChannels(),
            (channelID, channelKey) => {
              if (!appKeyHex) return
              // Unawaited, like every other read of a channel's engagement: the posts are
              // what the row is waiting on, and counts arriving a moment behind them is
              // the ordinary shape of this.
              void warmChannelTallies(appKeyHex, channelID, channelKey)
              void warmChannelConversations(appKeyHex, channelID, channelKey)
            },
          )
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
  }, [client, appKeyHex, wanted])
}
