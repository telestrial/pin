import { useEffect } from 'react'
import { fetchChannel } from '../../core/channels'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { makeLocatorFirstReader } from '../channelLocator'

// Phase D step 4a — flip channel reads to locator-first. When the sdk is present,
// inject a reader that resolves each channel via its pkarr locator (→ Sia → decrypt
// with K) and falls back to the atproto record on miss/error. This is the App-level
// wiring seam that keeps the feed store off the auth store (auth imports feed, so
// the reverse would be circular): App holds the sdk, builds the reader, injects it.
//
// Importing channelLocator pulls pkarr into the bundle, but the wasm only boots on
// the first actual locator resolve (lazy) — a feed refresh.
export function useChannelReader() {
  const sdk = useAuthStore((s) => s.sdk)

  useEffect(() => {
    const setReader = useFeedStore.getState().setChannelReader
    setReader(sdk ? makeLocatorFirstReader(sdk) : fetchChannel)
    // Revert to the atproto default when the sdk goes away (sign-out / lock reset).
    return () => setReader(fetchChannel)
  }, [sdk])
}
