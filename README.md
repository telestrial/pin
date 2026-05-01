# Pin

Decentralized personal feeds. Channels you own, subscriptions you pick, no platform between author and reader.

## What it does

A **channel** is a publishing handle — a person, a persona, a topic, a project, whatever the creator names it. You can own as many channels as you want, and subscribe to other people's by pasting their subscribe URL. Items inside a channel are typed: text (markdown — short notes inline, longer posts click-through), image, audio, video, file (catch-all for anything outside the strict media whitelists), or app (a self-contained HTML widget that runs in a sandboxed iframe — see the App host API section below). Your home is a chronological collation of items from every channel you've subscribed to, mixed across types.

When you find an item worth keeping, **pin it**. Pin mirrors the bytes into your own Sia storage, so your copy survives even if the original publisher unpins or disappears. The right sidebar surfaces your storage usage (`pinnedData / maxPinnedData`) and the items you've pinned; the bar fills as you commit. Pinning is a deliberate act backed by Sia storage cost — that's the social contract, and it's the verb the app is named after.

## Why it's cool

There is no Pin server, no Pin database, no platform between authors and readers. Item bytes live on Sia, encrypted with per-object keys. The mutable channel record (name, description, item refs) lives on ATProto as a publicly-readable record whose body is encrypted ciphertext under a per-channel key `K` — the key never appears anywhere except the URL fragment of the subscribe link. Anyone can fetch a channel's record from ATProto; only people you've sent the subscribe URL to can decrypt it. This composes the same "URL fragment is the access capability" pattern that Sia uses for object sharing, lifted to the channel layer.

**Pinning is the social contract.** A reader who pins becomes a host of those bytes — Sia's network gets stronger for that channel as more readers commit. An author can retract from their own storage (`sdk.deleteObject` walks the channel manifest and drops the bytes), but a subscriber who pinned keeps their copy and a working share URL. The post is gone from the original feed; it isn't gone everywhere. Twitter delete is unilateral; Pin retract is custody being released. **`K` is custody capability, not authorship credential** — anyone with `K` can stand up a parallel channel from their own ATProto repo (a fork), distinguished by the handle in the subscribe URL. That fork primitive is dormant in v1 but already supported by the architecture; see "Out of v1 scope" for the migration tool that would surface it.

## Setup

Requires [Bun](https://bun.sh) and Chrome. (Firefox's WebTransport stack misbehaves with the Sia WASM bridge — out of scope for v1; develop and demo in Chrome.)

```sh
bun install
bun run dev
```

Open the printed `http://localhost:5173` URL in Chrome. The first-time flow walks through Sia onboarding (Connect → Approve at sia.storage → save Recovery phrase → connected). Bluesky login is requested *lazily* on the first action that mutates ATProto state — creating, editing, publishing to, or unpinning a channel. Reading other people's channels and pinning their items needs no Bluesky session.

## Demo flow

1. **Window A (author)**: finish Sia + Bluesky onboarding. Click **+ Create a channel**, give it a name and (optionally) a cover image. Copy the subscribe URL.
2. **Window B (subscriber)**, ideally an Incognito window with a different Sia account to demonstrate cross-tenant: finish Sia onboarding only. Click **+ Subscribe** and paste Window A's subscribe URL.
3. Back in Window A: publish a few items from the inline composer at the top of the feed. **Drag a file directly onto the composer card** to auto-route to the right tab (image / audio / video / file / app, by MIME) and pre-fill it. The Note tab has a 281-character limit (one more than Twitter, intentional). Click Publish — the form resets immediately and the **upload queue** in the right sidebar takes over, ticking through shard-upload progress and finally going green when the manifest commits. The UI never blocks.
4. In Window B: items appear LIVE as Window A publishes — no refresh needed. Pin subscribes to ATProto's JetStream firehose, filtered to the channels you follow, so publishes propagate within ~1 second. The green pulsing **Live** indicator on the toolbar shows the WS connection. Manual Refresh stays as a backstop.
5. **Pin moment.** In Window B, hover an item and click the pin icon. The item is now mirrored into Window B's Sia storage; the right sidebar's bar ticks up and the item appears in **Pinned**. Then in Window A, click the (filled, owned-author-green) pin icon on the same item and type `DELETE` to retract. The item disappears from Window A's feed and storage — but Window B's pinned copy persists, with a working share URL. That's custody at work.

## Sia SDK usage

Pin uses [`@siafoundation/sia-storage`](https://www.npmjs.com/package/@siafoundation/sia-storage) load-bearingly:

| SDK call | Where it's used |
| --- | --- |
| `Sdk` instance per user | Every authenticated session ([core/sia.ts](src/core/sia.ts), AppKey approve flow from `create-sia-app`) |
| `sdk.upload(new PinnedObject(), Blob.stream())` | Every published item — note, post, image, audio, video, file, app — and channel cover art |
| `sdk.pinObject(obj)` | Two uses: durability for items you publish, AND mirroring an item from another channel into your own storage when you pin it |
| `sdk.shareObject(obj, validUntil)` | Per-item distribution URL with the per-object encryption key in the URL fragment; year-9999 expiries verified safe |
| `sdk.sharedObject(url)` | Resolves a shared URL into a `PinnedObject` handle. Used before downloading (subscriber reads) and before mirroring (pinning a friend's item — `sharedObject` then `pinObject` adds the bytes to your indexer scope) |
| `sdk.download(obj)` (as `ReadableStream`) | Subscriber reads (cached in IndexedDB after first fetch — see Architecture) |
| `sdk.deleteObject(id)` | Retraction. Item-level (typed-`DELETE` confirm on your own item) and channel-level (**Unpin channel** walks every item, then deletes the manifest record). Subscribers who mirrored items keep their independent copies |
| `sdk.account()` | The storage card at the top of the right sidebar — `pinnedData / maxPinnedData`, refreshed on every pin / unpin / retract |
| `sdk.appKey().publicKey()` | Recorded inside the encrypted channel manifest as the technical author identity |

ATProto via [`@atproto/api`](https://www.npmjs.com/package/@atproto/api) handles the channel-record layer: session login, `com.atproto.repo.putRecord` / `getRecord` / `listRecords` / `deleteRecord`. JetStream WS subscription (`wantedCollections=dev.sia.dispatch.channel&wantedDids=<sub-DIDs>`) handles live updates without polling. Together with Sia, they cover the two halves Sia explicitly does not aim to solve on its own — naming and mutability of multi-user-readable state.

## Architecture

```
Item bytes (per item)              Channel state (per channel)
        │                                   │
   Sia object                          ATProto record under
   (encrypted via                      dev.sia.dispatch.channel†
    per-object URL                     (publicly readable; body is
    fragment key)                       AES-GCM-256 ciphertext)
        │                                   │
        └────── itemURL ──────► ChannelManifest{name, description, items[]}
                                            │
                                  Encrypted under K
                                  rkey = base32(sha256(K)).slice(0,16)
                                  K lives only in the subscribe URL fragment
```

† The lexicon prefix `dev.sia.dispatch.channel` predates the app's rename to "Pin" and is preserved for stability. Existing channels round-trip without migration. The migration tool that would unblock a clean rename is described in "Out of v1 scope."

- **Channel ATProto record** body is *only* `{ $type, encryptedManifest }`. No client-controlled metadata fields.
- **Channel ID** (the rkey) is derived from `K`, not stored as a separate field. Listing an author's collection reveals only opaque rkeys.
- **Subscribe URL** is `pin://<authorHandle>#k=<base64-K>`. Sharing the URL = granting decrypt access. Without `K`, you can tell *that* the author publishes (via the rkey list) but nothing about *what*.
- **Item URLs** (which themselves contain Sia's per-object encryption keys in their fragments) are stored *inside* the encrypted manifest, so without `K` you also can't fetch the item bytes meaningfully.

**Performance layers — none of these are Sia, all of them shape how it feels.**

- **Local IndexedDB cache** (`lib/itemCache.ts`) — every item byte fetch goes through a content-addressed cache keyed on `itemURL`. Soft cap is `min(500 MB, 25 % of navigator.storage.estimate().quota)`, LRU eviction. First fetch hits Sia hosts; reload-and-rerender is sub-millisecond.
- **Background upload queue** (`stores/uploadQueue.ts`) — `Compose*` enqueues a task and resets the form; the runner serializes tasks, surfaces shard-upload progress in the right sidebar, supports retry on failure. Publish never blocks the UI.
- **JetStream live updates** (`core/jetstream.ts`) — WS subscription to Bluesky's JetStream firehose, filtered to the DIDs of your subscribed channels. Commit events trigger per-channel manifest re-fetches. Region (us-east / us-west) is timezone-derived. Reconnect uses exponential backoff and triggers a full refresh on rejoin.

```
src/
  core/        # platform-agnostic: Sia + ATProto calls, channel crypto, manifest, feed, jetstream, pin
  components/  # web UI (React)
  stores/      # Zustand — auth, feed, pin, upload queue, toast
  lib/         # constants, item cache, markdown, time helpers, app bridge, hooks
```

`core/` doesn't import React, DOM, or `localStorage`. A future React Native client (using `react-native-sia`) can be a new UI layer over the same module — the Sia and ATProto plumbing transfers unchanged.

## App host API

Items of type `app` (a single self-contained `.html` file) run inside an iframe with `sandbox="allow-scripts allow-modals allow-pointer-lock"`. The sandbox blocks network, popups, top-navigation, forms, same-origin access — an app can compute, render, and accept input but can't reach our DOM, our keys, or any external service.

It also can't use its own `localStorage` — null-origin iframes don't get storage. For state that should persist across sessions (high scores, save games, user preferences), the host exposes a `postMessage` RPC. State is scoped by `appID` (the Sia content hash of the HTML), so the same bytes share state across whichever channels publish them. Storage is local to the device; not synced across devices in v1. The protocol's `dispatch:` message-type prefix predates the app's rename and is preserved so that already-published apps continue to work.

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
- **Pagination, drafts, in-place item editing, AppView discovery.** Single-page manifest, single-attempt publishes per task, single-channel-key per channel. Item retraction (delete) ships in v1; in-place item edit does not.
- **Object packing.** Every Sia upload pays a full slab of erasure-coded redundancy regardless of content size — small text items are inefficient. `sdk.uploadPacked()` is the v2 fix.
- **Persistent upload queue.** Tab close during a slow upload drops the pending bytes. v2 stores task bytes in IndexedDB by task UUID so the queue resumes across reload.
- **Channel export / import (manifest portability).** A small JSON file containing `{ channelKey, channelID, manifest }` is the entire backup image of a channel. v2 surfaces **Download manifest** + **Import manifest** affordances. Import walks every item URL and re-pins the bytes into the importer's indexer scope (mandatory because each AppKey is a distinct pinned-objects scope), then republishes the manifest under the importer's DID. Same-user import = clean migration (AppKey rotation, cross-device portability, app-rebrand recovery — would have unblocked moving the lexicon off `dev.sia.dispatch.*` for the Pin rename). Different-user import = fork, surfaced as an explicit verb with a `forkedFrom` provenance field. The framing: **`K` is custody capability, not authorship credential.**

## Credits

Scaffolded from [SiaFoundation/create-sia-app](https://github.com/SiaFoundation/create-sia-app) by [Alex Freska](https://github.com/alexfreska).
