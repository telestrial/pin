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

// The relays Pin reaches the network through. See lib/relays.ts for what each kind
// carries, and scripts/relay-*.toml for the relays themselves.
//
// LOCAL is the default, and it is the whole set — nothing falls back to a public relay
// when these are down. A set gathered across one relay we run and one we don't makes an
// empty answer unattributable again, which is the thing running our own is meant to
// fix. Reaching the public path is a choice made on the welcome screen.
//
// 127.0.0.1 rather than localhost: on Windows that name resolves to ::1 first, and the
// relays bind IPv4.
/** Which set an instance is on. `custom` carries its own URLs in the store.
 *
 *  Here beside the sets rather than in core/types because nothing about it is
 *  serialized — it stays device-local, the way the indexer URL does. */
export type RelayPreset = 'local' | 'public' | 'custom'

export const LOCAL_PKARR_RELAYS = ['http://127.0.0.1:6881']
export const LOCAL_IROH_RELAYS = ['http://127.0.0.1:3340']

// The public set, for when the local relays are not the point. The pkarr pair is
// pubky's and is where every record published before any of this was configurable
// lives; the iroh four are n0's, matching what `presets::N0` bound to.
export const PUBLIC_PKARR_RELAYS = [
  'https://pkarr.pubky.org',
  'https://pkarr.pubky.app',
]
export const PUBLIC_IROH_RELAYS = [
  'https://use1-1.relay.n0.iroh.link.',
  'https://usw1-1.relay.n0.iroh.link.',
  'https://euc1-1.relay.n0.iroh.link.',
  'https://aps1-1.relay.n0.iroh.link.',
]

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
