import { useEffect } from 'react'
import { connectJetstream } from '../core/jetstream'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'

export function useJetstream() {
  const subscriptions = useAuthStore((s) => s.subscriptions)

  useEffect(() => {
    const dids = subscriptions
      .map((s) => s.authorDID)
      .filter((d): d is string => !!d)
    if (dids.length === 0) return

    let isFirstConnect = true

    const conn = connectJetstream(dids, {
      onCommit: ({ did, rkey, operation }) => {
        const subs = useAuthStore.getState().subscriptions
        const sub = subs.find(
          (s) =>
            (s.authorDID || s.authorHandle) === did && s.channelID === rkey,
        )
        if (!sub) return
        if (operation === 'delete') {
          // Author retracted the channel — drop the subscription and its
          // feed entries so subscribers' UIs don't show a ghost channel.
          useAuthStore.getState().removeSubscription(sub.channelID)
          useFeedStore.getState().removeChannel(sub.channelID)
          return
        }
        void useFeedStore.getState().refreshChannel(sub)
      },
      onConnected: () => {
        useFeedStore.getState().setLive(true)
        if (isFirstConnect) {
          isFirstConnect = false
          return
        }
        void useFeedStore
          .getState()
          .refresh(useAuthStore.getState().subscriptions)
      },
      onDisconnected: () => {
        useFeedStore.getState().setLive(false)
      },
    })

    return () => {
      conn.close()
      useFeedStore.getState().setLive(false)
    }
  }, [subscriptions])
}
