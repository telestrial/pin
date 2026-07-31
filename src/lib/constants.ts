// The app metadata Sia identifies us by — the AppID, the name, the service URL —
// now has one definition, in crates/pin-sia, because that is where the connect flow
// runs. What remains here is the AppID's value used as a LOCAL STORAGE NAMESPACE
// (`sia-auth-<first16>`, `sia-pins-<first16>`). It is the same hex, but its job here
// is naming a browser key, so changing it would orphan a user's persisted state
// rather than break Sia.
// biome-ignore format: long hex literal
export const APP_KEY = 'f6b7539e181e45ee750a491a58aa8392830a17c402115cf47c6e7dfe9f7ffcb0'
export const APP_NAME = 'Pin'
export const DEFAULT_INDEXER_URL = 'https://sia.storage'

// Erasure coding parameters — passed to sdk.upload() and encodedSize().
export const DATA_SHARDS = 10
export const PARITY_SHARDS = 20

// One more than Twitter's 280. Calmly, intentionally distinct.
export const NOTE_CHAR_LIMIT = 281

// iframe sandbox flags for the app item type. Strict-by-default; each token
// adds back one capability. Notably absent: allow-same-origin (would let the
// iframe read our state), allow-forms (exfiltration via form POST),
// allow-popups, allow-top-navigation (redirect attacks), allow-downloads.
export const APP_SANDBOX = 'allow-scripts allow-modals allow-pointer-lock'
