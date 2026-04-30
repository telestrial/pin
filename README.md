# Dispatch

Decentralized personal feeds. Channels you own, subscriptions you pick, no platform between author and reader.

## What it does

A **channel** is a publishing handle — a person, a persona, a topic, a project, whatever the creator names it. You can own as many channels as you want, and subscribe to other people's by pasting their subscribe URL. Items inside a channel are typed: text (markdown), image, audio, or video. Your home is a chronological collation of items from every channel you've subscribed to, mixed across types.

## Why it's cool

There is no Dispatch server, no Dispatch database, no platform between authors and readers. Item bytes live on Sia, encrypted with per-object keys. The mutable channel record (name, description, item refs) lives on ATProto as a publicly-readable record whose body is encrypted ciphertext under a per-channel key `K` — the key never appears anywhere except the URL fragment of the subscribe link. Anyone can fetch a channel's record from ATProto; only people you've sent the subscribe URL to can decrypt it. This composes the same "URL fragment is the access capability" pattern that Sia uses for object sharing, lifted to the channel layer.

The product around that architecture is deliberately calm: no notifications, no like counts, no algorithmic feed, no replies, no @mentions, no threads. Friend-scaled, not follower-scaled. A reply is a new item in some channel; the conversation emerges from what people publish in response to each other.

## Setup

Requires [Bun](https://bun.sh) and Chrome. (Firefox's WebTransport stack misbehaves with the Sia WASM bridge — out of scope for v1; develop and demo in Chrome.)

```sh
bun install
bun run dev
```

Open the printed `http://localhost:5173` URL in Chrome. The first-time flow walks through Sia onboarding (Connect → Approve at sia.storage → save Recovery phrase → connected). Bluesky login is requested *lazily* on first **Create a channel** or **Publish** action; reading other people's channels needs no Bluesky session.

## Demo flow

1. **Window A (author)**: finish Sia + Bluesky onboarding. Click **Create a channel**, give it a name. Copy the subscribe URL.
2. **Window B (subscriber)**, ideally an Incognito window with a different Sia account to demonstrate cross-tenant: finish Sia onboarding only. Click **Subscribe to a channel** and paste Window A's subscribe URL.
3. Back in Window A: **Your channels** → publish a text item, an image, an audio clip, and a video. ~20 seconds per upload (Sia per-object full-slab erasure-coded redundancy).
4. In Window B: **Refresh** the feed. All four items appear, mixed chronologically. Click each to read or play.

## Sia SDK usage

Dispatch uses [`@siafoundation/sia-storage`](https://www.npmjs.com/package/@siafoundation/sia-storage) load-bearingly:

| SDK call | Where it's used |
| --- | --- |
| `Sdk` instance per user | Every authenticated session ([core/sia.ts](src/core/sia.ts), AppKey approve flow from `create-sia-app`) |
| `sdk.upload(new PinnedObject(), Blob.stream())` | Every published item — text, image, audio, video |
| `sdk.pinObject(obj)` | Durability for every published item |
| `sdk.shareObject(obj, validUntil)` | Per-item distribution URL with the per-object encryption key in the URL fragment; year-9999 expiries verified safe |
| `sdk.sharedObject(url)` + `sdk.download(obj)` (as `ReadableStream`) | Every subscriber read |
| `sdk.appKey().publicKey()` | Recorded inside the encrypted channel manifest as the technical author identity |

ATProto via [`@atproto/api`](https://www.npmjs.com/package/@atproto/api) handles the channel-record layer: session login, `com.atproto.repo.putRecord` / `getRecord` / `listRecords`. Together they cover the two halves Sia explicitly does not aim to solve on its own — naming and mutability of multi-user-readable state.

## Architecture

```
Item bytes (per item)              Channel state (per channel)
        │                                   │
   Sia object                          ATProto record under
   (encrypted via                      dev.sia.dispatch.channel
    per-object URL                     (publicly readable; body is
    fragment key)                       AES-GCM-256 ciphertext)
        │                                   │
        └────── itemURL ──────► ChannelManifest{name, description, items[]}
                                            │
                                  Encrypted under K
                                  rkey = base32(sha256(K)).slice(0,16)
                                  K lives only in the subscribe URL fragment
```

- **Channel ATProto record** body is *only* `{ $type, encryptedManifest }`. No client-controlled metadata fields.
- **Channel ID** (the rkey) is derived from `K`, not stored as a separate field. Listing an author's collection reveals only opaque rkeys.
- **Subscribe URL** is `dispatch://<authorHandle>#k=<base64-K>`. Sharing the URL = granting decrypt access. Without `K`, you can tell *that* the author publishes (via the rkey list) but nothing about *what*.
- **Item URLs** (which themselves contain Sia's per-object encryption keys in their fragments) are stored *inside* the encrypted manifest, so without `K` you also can't fetch the item bytes meaningfully.

```
src/
  core/        # platform-agnostic: Sia + ATProto calls, channel crypto, manifest, feed
  components/  # web UI (React)
  stores/      # Zustand
  lib/         # constants
```

`core/` doesn't import React, DOM, or `localStorage`. A future React Native client (using `react-native-sia`) can be a new UI layer over the same module — the Sia and ATProto plumbing transfers unchanged.

## App host API

Items of type `app` (a single self-contained `.html` file) run inside an iframe with `sandbox="allow-scripts allow-modals allow-pointer-lock"`. The sandbox blocks network, popups, top-navigation, forms, same-origin access — an app can compute, render, and accept input but can't reach our DOM, our keys, or any external service.

It also can't use its own `localStorage` — null-origin iframes don't get storage. For state that should persist across sessions (high scores, save games, user preferences), the host exposes a `postMessage` RPC. State is scoped by `appID` (the Sia content hash of the HTML), so the same bytes share state across whichever channels publish them. Storage is local to the device; not synced across devices in v1.

### Read a stored value

```js
const requestID = crypto.randomUUID()
window.parent.postMessage(
  { type: 'dispatch:state.get', requestID, key: 'hiscore' },
  '*',
)
window.addEventListener('message', (e) => {
  if (
    e.data?.type === 'dispatch:state.get.result' &&
    e.data.requestID === requestID
  ) {
    console.log(e.data.value) // null if unset, otherwise the stored value
  }
})
```

### Write a value

```js
window.parent.postMessage(
  {
    type: 'dispatch:state.set',
    requestID: crypto.randomUUID(),
    key: 'hiscore',
    value: 42,
  },
  '*',
)
```

Values are JSON-serialized; anything `JSON.stringify` accepts works. The host replies with `{ type: 'dispatch:state.set.result', requestID, ok: true }`, or `{ ok: false, error }` on failure (quota exceeded, serialization failed).

## Out of v1 scope

- **Per-recipient access control + revocation.** v1 is "everyone with the subscribe URL has equal access" — same model as Sia's `shareObject`. v2 plan: per-subscriber NaCl box envelopes via a separate ATProto record collection, plus key rotation on removal.
- **Notifications, replies, likes, mentions, threads.** Intentionally absent — not a v2 plan either. Conversation by inference, not threading.
- **Native mobile.** `core/` is platform-agnostic and ready; v1 ships the web SPA only.
- **Pagination, drafts, item editing, AppView discovery.** Single-page manifest, single-attempt publishes, single-channel-key per channel.
- **Object packing.** Every Sia upload pays a full slab of erasure-coded redundancy regardless of content size — small text items are inefficient. `sdk.uploadPacked()` is the v2 fix.
