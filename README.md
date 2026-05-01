# Pin

Decentralized personal feeds. Channels you own, subscriptions you pick, no platform between author and reader.

https://github.com/user-attachments/assets/cba3bc35-934c-4e58-a372-1358824e49f2

## What it does

A **channel** is a publishing handle — a person, a persona, a topic, a project. You own as many as you want and subscribe to others' by pasting a URL. Items inside a channel are typed: text (notes inline, posts click-through), image, audio, video, file, or app (a self-contained HTML widget that runs in a sandboxed iframe). Your home is a chronological mix from every channel you've subscribed to. When something's worth keeping, **pin it** — pinning mirrors the bytes into your own Sia storage so your copy survives even if the original publisher unpins. It's the verb the app is named after.

## Why it's cool

There is no Pin server, no Pin database, no platform between authors and readers. Item bytes live on Sia, encrypted with per-object keys. The mutable channel record lives on ATProto as a publicly-readable record whose body is ciphertext encrypted under a per-channel key `K` that never leaves the URL fragment of the subscribe link. Anyone can fetch a record; only people you sent the URL to can decrypt it. A reader who pins becomes a host of those bytes — Sia gets stronger for that channel as more readers commit. An author can retract from their own storage, but a subscriber's pinned copy persists. Twitter delete is unilateral; Pin retract is custody being released.

## Demo flow

### ▶ [pin-liard.vercel.app](https://pin-liard.vercel.app/)

Best in Chrome. Best with a friend — pair up, each open the URL on your own machine, walk through it together. One of you plays the author, the other the subscriber. (Solo? Two browser windows on one machine, Incognito for the second so the Sia accounts stay distinct.)

1. **Both of you**: finish Sia onboarding. Then click **+ Subscribe** and paste this — it's the build journal I kept while making Pin:

   ```
   pin://johnwilliams.codes#k=zDaitAkRQnSa2X3YsNXlLEomoIStjfGyxSlbIL0/7bs=
   ```

   Your feed populates immediately with the day-by-day record of building this app. That's what subscribing to a real channel feels like.

2. **Author** (one of you): also finish Bluesky onboarding. Click **+ Create a channel**, give it a name and (optionally) a cover image. Copy the subscribe URL and send it to the subscriber.
3. **Subscriber** (the other): in **+ Subscribe**, paste the author's URL.
4. **Author**: publish a few items from the inline composer at the top of the feed. **Drag a file directly onto the composer card** to auto-route to the right tab (image / audio / video / file / app, by MIME) and pre-fill it. The Note tab has a 281-character limit (one more than Twitter, intentional). Click Publish — the form resets immediately and the **upload queue** in the right sidebar takes over, ticking through shard-upload progress and finally going green when the manifest commits. The UI never blocks.
5. **Subscriber**: items appear LIVE as the author publishes — no refresh needed. Pin subscribes to ATProto's JetStream firehose, filtered to the channels you follow, so publishes propagate within ~1 second. The green pulsing **Live** indicator on the toolbar shows the WS connection. Manual Refresh stays as a backstop.
6. **Pin moment.** **Subscriber**: hover an item and click the pin icon. The item is now mirrored into your Sia storage; the right sidebar's bar ticks up and the item appears in **Pinned**. Then the **author**: click the (filled, owned-author-green) pin icon on the same item and type `DELETE` to retract. The item disappears from the author's feed and storage — but the subscriber's pinned copy persists, with a working share URL. That's custody at work.

---

The rest of this README goes deeper: the specific Sia SDK calls Pin uses (and where), the architecture, the sandboxed App Host API, what's out of v1 scope, and how to run locally if you want to clone instead of clicking the link above.

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

A program-as-item — type `app`, a single self-contained `.html` file — is one of the more interesting consequences of the architecture. The program is content-addressed, encrypted, and distributed by exactly the same machinery as a JPEG: it travels like media. Pong, included as a bundled example, ships in a channel as a small HTML file you can subscribe to, fetch, and run. Where it gets interesting is what an app should and shouldn't be able to *do* — that surface is barely sketched in v1.

Apps run inside an iframe with `sandbox="allow-scripts allow-modals allow-pointer-lock"`. The sandbox blocks network, popups, top-navigation, forms, and same-origin access — an app can compute, render, and accept input, but can't reach our DOM, our keys, the user's other tabs, or any external service. Anything an app needs from the outside has to come through a `postMessage` channel the host explicitly proxies. **That's the permission boundary**: the host decides which capabilities it exposes as RPCs, and apps are free to use only those.

### What we shipped in v1

One RPC pair: per-app local state. Null-origin iframes don't get their own `localStorage`, so the host exposes get/set so apps can persist things like high scores, save games, or preferences. State is scoped by `appID` (the Sia content hash of the HTML), so the same bytes share state across whichever channels publish them. Storage is local to the device; not synced across devices in v1. The protocol's `dispatch:` message-type prefix predates the app's rename and is preserved so that already-published apps continue to work.

#### Read a stored value

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

#### Write a value

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

### How could an app actually use Sia?

The sandbox blocks network and same-origin access, so an app can't call Sia hosts itself. There are roughly three shapes for letting an app *use* the SDK without giving it free rein, each with a different place where permission lives:

1. **Host-as-proxy (the v1 shape).** The host has the SDK; the app makes typed `postMessage` requests; the host executes and returns the result. Permission lives at the RPC boundary — we approve or deny each call individually. Simple to reason about. The API the app sees isn't shaped like the SDK; it's shaped like whatever message types we choose to expose.

2. **SDK-as-contract.** The app imports a shim that *looks* like the SDK (`await sdk.upload(...)`), and the shim marshals each call over `postMessage`. The host implements the SDK on the app's behalf. App code reads like ordinary SDK usage; permission still lives at the host boundary, but the contract is the SDK itself. This is the cleanest shape if we ever want apps to be portable to other host environments — a desktop runtime, a different web client, a CLI — without rewriting them.

3. **AppKey-per-app.** Sia's existing `AppKey` *is* the permission primitive — every authenticated session is scoped to one, and the indexer already enforces per-AppKey storage caps (`maxPinnedData`, `remainingStorage`). We could derive a sub-AppKey deterministically from `(user-AppKey, appID)`, let the app run a real SDK instance against that sub-key, and have the user approve a storage cap at install time. The sandbox still blocks raw network, but the host could expose just enough of a network shim for the app's SDK to reach the indexer — gated by the sub-AppKey's authorization. The most federated shape: each app becomes a first-class Sia identity, with its own quota and an isolated pinned set, separate from the host user's.

The third shape is architecturally interesting because **Sia already has the permission primitive — we don't need to invent one**. Storage cap, isolated pinned set, all derivable from a root identity. We'd be making the AppKey hierarchy one level deeper, and the existing indexer enforcement comes along for free. v1 ships shape #1 because it was the smallest thing that worked for pong's hi-score; v2 thinking probably starts at #3.

### What's open

Pong is one example; the broader question — what *should* an app be able to do — is barely explored. Every capability beyond pure compute is a host-side permission decision, and none of them are settled. A non-exhaustive list of questions v2 has to answer, in roughly increasing order of risk:

- **Read other items in the same channel.** Useful (an app could render its own playlist over audio items in the channel), low risk.
- **Read the manifest's metadata** (channel name, description, item refs). Same shape — useful for context-aware apps.
- **Upload a new item to its own channel.** Only meaningful if the running user owns the channel; needs an explicit "this app wants to publish on your behalf" prompt to avoid vandalism.
- **See the user's pinned set.** Privacy concern; probably no by default.
- **Sign with the user's `AppKey`.** Identity proxy — powerful and dangerous; needs explicit per-call consent UI.
- **Pin a URL the app constructs.** Storage-cost vector against the user's Sia allowance; needs consent and probably a size cap.

The framing that makes this tractable: apps can't reach Sia or ATProto directly. Anything they do goes through host RPCs. So designing the App Host API is the same exercise as designing a permission surface over the Sia SDK — *which calls are safe to proxy, under what consent model, at what scope*. v1 says "compute and your own state, nothing else." Growing that surface is a v2 question.

## Out of v1 scope

- **Per-recipient access control + revocation.** v1 is "everyone with the subscribe URL has equal access" — same model as Sia's `shareObject`. v2 plan: per-subscriber NaCl box envelopes via a separate ATProto record collection, plus key rotation on removal.
- **Notifications, replies, likes, mentions, threads.** Intentionally absent — not a v2 plan either. Conversation by inference, not threading.
- **Native mobile.** `core/` is platform-agnostic and ready; v1 ships the web SPA only.
- **Editing.** Channel metadata (name, description, cover image) is fully editable from the channel header. **Posts** (text items with a title) and **apps** (HTML items) are editable in v1: title and/or body. The implementation uploads new bytes to Sia and only swaps the manifest pointer if the upload succeeds; on failure the old version stays live and the orphan upload is rolled back. Edited items keep their original `publishedAt` so editing isn't republishing — they stay where they were in chronological order. Apps editing is the load-bearing case: ship a program, find a bug, fix it in place. Notes (titleless short-form text) and other media types (image, audio, video, file) are not editable in v1; retract and republish. **Pinned copies on subscribers' devices are *snapshots*** — an author's edit changes the manifest's pointer, but readers' mirrored bytes stay as they were when they pinned. That's true to "K is custody, not authorship": the reader's pin is fixed-in-time stewardship; the author's edit doesn't reach into the reader's library.
- **Pagination, drafts, AppView discovery.** Single-page manifest, single-channel-key per channel.
- **Object packing.** Every Sia upload pays a full slab of erasure-coded redundancy regardless of content size — small text items are inefficient. `sdk.uploadPacked()` is the v2 fix.
- **Persistent upload queue.** Tab close during a slow upload drops the pending bytes. v2 stores task bytes in IndexedDB by task UUID so the queue resumes across reload.
- **Channel export / import (manifest portability).** A small JSON file containing `{ channelKey, channelID, manifest }` is the entire backup image of a channel. v2 surfaces **Download manifest** + **Import manifest** affordances. Import walks every item URL and re-pins the bytes into the importer's indexer scope (mandatory because each AppKey is a distinct pinned-objects scope), then republishes the manifest under the importer's DID. Same-user import = clean migration (AppKey rotation, cross-device portability, app-rebrand recovery — would have unblocked moving the lexicon off `dev.sia.dispatch.*` for the Pin rename). Different-user import = fork, surfaced as an explicit verb with a `forkedFrom` provenance field. The framing: **`K` is custody capability, not authorship credential.**
- **Collections / albums.** v1 has no way to group items — posting 10 photos means publishing 10 times, and they appear as 10 rows in the feed. The schema question worth working through: does an album become *one item with N media URLs* (`itemURL` becomes `itemURLs[]`, and "single image" is just N=1), *one item-of-type-`collection`* whose body references other items, or *N items with a shared `groupID`* (manifest-level grouping, per-item bytes stay flat)? Each has different ergonomics for the **pin** verb. Multi-URL or group-ID let a subscriber pin the whole collection or just one image inside it; collection-type maps pin cleanly to the whole. Sia cost stays the same regardless — N photos = N objects = N slabs of redundancy — but `sdk.uploadPacked()` becomes load-bearing for any of these shapes, since collection authors publish in bursts. Lean: **multi-URL ItemRef.** Cleanest schema migration; single-image is just N=1; rendering branches once on count; pin granularity stays at the URL level, so subscribers can keep partial collections after pinning.

## Run it locally

If you'd rather clone than click. Requires [Bun](https://bun.sh) and Chrome.

```sh
bun install
bun run dev
```

Open the printed `http://localhost:5173` URL in Chrome. The first-time flow walks through Sia onboarding (Connect → Approve at sia.storage → save Recovery phrase → connected). Bluesky login is requested *lazily* on the first action that mutates ATProto state — creating, editing, publishing to, or unpinning a channel.

A note on browser support: we pinned `@siafoundation/sia-storage` early and built against Chrome throughout the 3-day window. Cross-browser validation was out of scope — Chrome was the target, it was green from day one, and we kept iterating. The app may run elsewhere, but Chrome is the only environment we exercised.

## Credits

Pin sits on infrastructure built by other people:

- **My colleagues at the [Sia Foundation](https://sia.tech)** maintain [the libraries](https://github.com/SiaFoundation) advancing the broader [Sia network](https://sia.tech): [Luke Champine](https://github.com/lukechampine), [Nate](https://github.com/n8mgr), [Christopher Schinnerl](https://github.com/ChrisSchinnerl), [Peter-Jan Brone](https://github.com/peterjan), [Christopher Tarry](https://github.com/chris124567), [Alrighttt](https://github.com/Alrighttt), and [Alex Freska](https://github.com/alexfreska).
- **[ATProto](https://atproto.com) and [Bluesky](https://bsky.app)** for the protocol and the public infrastructure (PDS, [JetStream](https://github.com/bluesky-social/jetstream) relay) that handle Pin's mutable channel-naming layer. `@atproto/api` for client calls; the JetStream firehose for sub-second live updates without polling.

Scaffolded from [SiaFoundation/create-sia-app](https://github.com/SiaFoundation/create-sia-app) by [Alex Freska](https://github.com/alexfreska).
