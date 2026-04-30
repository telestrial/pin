import type { AppMetadata } from '@siafoundation/sia-storage'

// biome-ignore format: long hex literal
export const APP_KEY = 'f6b7539e181e45ee750a491a58aa8392830a17c402115cf47c6e7dfe9f7ffcb0'
export const APP_NAME = 'Dispatch'
export const DEFAULT_INDEXER_URL = 'https://sia.storage'
export const APP_META: AppMetadata = {
  appId: APP_KEY,
  name: APP_NAME,
  description: 'A Sia storage app',
  serviceUrl: 'https://sia.storage',
  logoUrl: undefined,
  callbackUrl: undefined,
}

// Erasure coding parameters — passed to sdk.upload() and encodedSize().
export const DATA_SHARDS = 10
export const PARITY_SHARDS = 20

// iframe sandbox flags for the webapp item type. Strict-by-default; each token
// adds back one capability. Notably absent: allow-same-origin (would let the
// iframe read our state), allow-forms (exfiltration via form POST),
// allow-popups, allow-top-navigation (redirect attacks), allow-downloads.
export const WEBAPP_SANDBOX = 'allow-scripts allow-modals allow-pointer-lock'
