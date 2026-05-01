// One-off recovery helpers exposed on window.pinDebug for console use.
// Useful for fetching a settings object directly by ID, or restoring
// myChannels/subscriptions from a previously-saved recovery.json.
//
// Safe to leave in production — these are explicit-action helpers, not
// auto-running. Remove later if desired.

import { useAuthStore } from '../stores/auth'

declare global {
  interface Window {
    pinDebug?: {
      fetchSettings: (objectID: string) => Promise<unknown>
      restoreFromRecovery: (recovery: {
        myChannels?: unknown[]
        subscriptions?: unknown[]
      }) => void
    }
  }
}

if (typeof window !== 'undefined') {
  window.pinDebug = {
    async fetchSettings(objectID: string) {
      const sdk = useAuthStore.getState().sdk
      if (!sdk) throw new Error('Not connected — sign in to Sia first')
      const obj = await sdk.object(objectID)
      const stream = sdk.download(obj)
      const text = await new Response(stream).text()
      return JSON.parse(text)
    },
    restoreFromRecovery(recovery) {
      const store = useAuthStore.getState()
      if (recovery.myChannels && Array.isArray(recovery.myChannels)) {
        for (const ch of recovery.myChannels as Parameters<
          typeof store.addMyChannel
        >[0][]) {
          store.addMyChannel(ch)
        }
      }
      if (recovery.subscriptions && Array.isArray(recovery.subscriptions)) {
        for (const sub of recovery.subscriptions as Parameters<
          typeof store.addSubscription
        >[0][]) {
          store.addSubscription(sub)
        }
      }
      console.log('Restored. Refresh the feed to see channels.')
    },
  }
}
