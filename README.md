# Pin

Decentralized personal feeds. Channels you own, subscriptions you pick, no platform between author and reader.

https://github.com/user-attachments/assets/cba3bc35-934c-4e58-a372-1358824e49f2

## What it does

A **channel** is a publishing handle — a person, a persona, a topic, a project. You own as many as you want and subscribe to others' by pasting a URL. The thing you publish is a **post** — short plaintext (281 characters, one more than Twitter, intentional), optionally with attachments (images, audio, video, files, or HTML apps that run sandboxed inline) shown beneath the body. Your home is a chronological mix from every channel you've subscribed to. When something's worth keeping, **pin it** — pinning mirrors the bytes into your own Sia storage so your copy survives even if the original publisher unpins. It's the verb the app is named after.

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
4. **Author**: publish from the inline composer at the top of the feed. The composer is one line at rest — click it and it expands. Type your post (up to 281 characters), and **drag a file onto the composer** to attach it (image / audio / video / file) below the body. Click Publish — the form clears immediately, and the **upload queue** in the right sidebar takes over, uploading the attachment bytes then the body bytes then writing the manifest entry. The UI never blocks.
5. **Subscriber**: items appear LIVE as the author publishes — no refresh needed. Pin subscribes to ATProto's JetStream firehose, filtered to the channels you follow, so publishes propagate within ~1 second. The green pulsing **Live** indicator on the toolbar shows the WS connection. Manual Refresh stays as a backstop.
6. **Pin moment.** **Subscriber**: hover an item and click the pin icon. The item is now mirrored into your Sia storage; the right sidebar's bar ticks up and the item appears in **Pinned**. Then the **author**: click the (filled, owned-author-green) pin icon on the same item and type `DELETE` to retract. The item disappears from the author's feed and storage — but the subscriber's pinned copy persists, with a working share URL. That's custody at work.

---

The rest of this README goes deeper: the specific Sia SDK calls Pin uses (and where), the architecture, the sandboxed App Host API, the roadmap, and how to run locally if you want to clone instead of clicking the link above.

## Sia SDK usage

Pin uses [`@siafoundation/sia-storage`](https://www.npmjs.com/package/@siafoundation/sia-storage) load-bearingly:

| SDK call | Where it's used |
| --- | --- |
| `Sdk` instance per user | Every authenticated session ([core/sia.ts](src/core/sia.ts), AppKey approve flow from `create-sia-app`) |
| `sdk.upload(new PinnedObject(), Blob.stream())` | Post body bytes, every attachment file on a post, channel cover art, profile avatar / cover image bytes. The composer never blocks on upload — bytes get pushed to Sia by the background runner after Publish, then the manifest is written with the resolved URLs. |
| `sdk.pinObject(obj)` | Two uses: durability for items you publish (body and each attachment), and mirroring an item from another channel into your own storage when you pin it from the feed |
| `sdk.shareObject(obj, validUntil)` | Per-item distribution URL with the per-object encryption key in the URL fragment; year-9999 expiries verified safe |
| `sdk.sharedObject(url)` | Resolves a shared URL into a `PinnedObject` handle. Used before downloading (subscriber reads) and before mirroring (pinning a friend's item — `sharedObject` then `pinObject` adds the bytes to your indexer scope) |
| `sdk.download(obj)` (as `ReadableStream`) | Subscriber reads (cached in IndexedDB after first fetch — see Architecture) |
| `sdk.deleteObject(id)` | Retraction. Item-level (typed-`DELETE` confirm on your own item) and channel-level (**Unpin channel** walks every item, then deletes the manifest record). Subscribers who mirrored items keep their independent copies |
| `sdk.uploadPacked()` + `packed.add(stream)` + `packed.finalize()` | Bin-packed multi-object uploads. Composer tasks (post body + attachments) and drag-drop intake into My Storage share a single ~40 MiB slab rather than one slab per object. Same call powers the background repack runner that consolidates sub-full slabs after the fact |
| `obj.slabs()` | Per-object slab inventory (`encryptionKey`, `offset`, `length`, `sectors`). The repack runner reads this to compute fill levels and pick consolidation batches; the SlabInspector debug view uses it for the per-slab object listing |
| `sdk.objectEvents(cursor, limit)` | Paginated walk of every pinned object in scope. Used by the orphan sweep to enumerate scope and diff against the known set so pinned-but-unreferenced bytes (typically from failed historic repacks) get cleaned up |
| `sdk.pruneSlabs()` | Releases unused slab capacity after `deleteObject`. The indexer doesn't auto-drop empty slabs, so without this `pinnedData` stays inflated even after deletes succeed. Called at the end of every repack batch and orphan-sweep pass — load-bearing for the bar to actually fall |
| `sdk.account()` | The storage card at the top of the right sidebar — `pinnedData / maxPinnedData`, refreshed on every pin / unpin / retract / repack / orphan-sweep |
| `sdk.appKey().publicKey()` | Recorded inside the encrypted channel manifest as the technical author identity |

ATProto handles the naming layer: [`@atproto/oauth-client-browser`](https://www.npmjs.com/package/@atproto/oauth-client-browser) for the user sign-in (standards OAuth handoff — Pin never sees their password), [`@atproto/api`](https://www.npmjs.com/package/@atproto/api) for the resulting Agent's `com.atproto.repo.putRecord` / `getRecord` / `listRecords` / `deleteRecord` calls. The OAuth scope is narrow — `repo:dev.sia.pin.channel repo:dev.sia.pin.profile repo:dev.sia.pin.subscription` — so the auth screen at bsky.social grants access only to the three lexicons Pin actually writes to (channels, profile, public follows), never to `app.bsky.*` surfaces like the user's posts / likes / follows. JetStream WS subscription handles live updates without polling. Together with Sia, ATProto covers the two halves Sia explicitly does not aim to solve on its own — naming and mutability of multi-user-readable state.

## Architecture

```
Item bytes (per item)              Channel state (per channel)
        │                                   │
   Sia object                          ATProto record under
   (encrypted via                      dev.sia.pin.channel
    per-object URL                     (publicly readable; body is
    fragment key)                       AES-GCM-256 ciphertext)
        │                                   │
        └────── itemURL ──────► ChannelManifest{name, description, items[]}
                                            │
                                  Encrypted under K
                                  rkey = base32(sha256(K)).slice(0,16)
                                  K lives only in the subscribe URL fragment
```

- **Channel ATProto record** body is `{ $type, encryptedManifest, key? }`. For obscure channels (Watch-only — the historical default), `key` is omitted and only subscribe-URL holders can decrypt. For public channels (declared at creation), K is published alongside the ciphertext in `key`, so a reader walking another user's public follow list can fetch and decrypt the manifest without holding K locally.
- **Channel ID** (the rkey) is derived from `K`, not stored as a separate field. Listing an author's collection reveals only opaque rkeys.
- **Subscribe URL** is `pin://<authorHandle>#k=<base64-K>`. Sharing the URL = granting decrypt access. Without `K`, you can tell *that* the author publishes (via the rkey list) but nothing about *what* — for obscure channels. For public channels, the channel record itself carries K, so the URL fragment is convenience rather than the only path.
- **Channel visibility** is `'obscure' | 'public'`, set at creation and sticky. Flipping public → obscure would orphan existing followers (the AT-URI in their follow records would suddenly stop resolving); flipping obscure → public would unilaterally give every channel-record reader the key they didn't have before. Both refused.
- **Item URLs** (which themselves contain Sia's per-object encryption keys in their fragments) are stored *inside* the encrypted manifest, so reading items requires either holding K (obscure) or extracting K from the record body (public).

**Identity layer.** A person's address is their handle on atproto (`john.bsky.social`, `johnwilliams.codes`, whatever) — universal, no Pin in the path. Pin builds on top:

- **Profile record** at `at://<did>/dev.sia.pin.profile/self`, well-known rkey parallel to `app.bsky.actor.profile/self`. Body: optional `displayName`, `bio`, `avatarURL` (Sia share URL with per-object key in fragment), `coverURL`, plus `updatedAt`. Pure identity — no channel list, no follow list. Discoverability happens via separate follow records.
- **Public follow records** under each follower's repo at `at://<follower-did>/dev.sia.pin.subscription/<rkey>` with body `{ subject: <channel AT-URI>, createdAt }`. Same stand-off pattern Bluesky uses for likes / follows / reposts — each follow is its own record, no central index. The rkey is `base32(sha256(subject))[:16]` so re-following is idempotent and unfollow is a single `deleteRecord` call without a list-then-find scan.
- **Handle directory.** Clicking any `@handle` anywhere opens that handle's directory: profile header up top (avatar + cover + displayName + bio with @handle fallback), then two sections derived from the same public-follow walk — **Their voices** lists channels they publicly follow whose `authorDID` matches their own (the channel-as-voice claim of authorship), and **Following** lists everyone else they follow. Reached via in-app navigation; the directory is *how Pin renders any handle a user encounters in-app*, not a paste-this-URL surface.
- **Watch vs Follow.** Subscribing via the `pin://<handle>#k=<K>` URL is Watch — purely local state, no record under your repo, works for both obscure and public channels. Clicking Follow on a public channel page additionally writes a `dev.sia.pin.subscription` record under your DID; that's the signal the directory page walks. Two psychological commitments, two real verbs.

Pin's OAuth scope is correspondingly narrow — `repo:dev.sia.pin.channel repo:dev.sia.pin.profile repo:dev.sia.pin.subscription`. The auth screen at bsky.social grants access only to the lexicons Pin actually writes to. No `app.bsky.*` surface.

**Performance layers — none of these are Sia, all of them shape how it feels.**

- **Local IndexedDB cache** (`lib/itemCache.ts`) — every item byte fetch goes through a cache keyed on the item's plaintext **CIDv1 content hash** (`core/contentHash.ts`), with `itemURL` as the fallback for legacy items written before the hash field existed. The hash is stable across repack URL swaps and across encryption regimes (today's K-encrypted manifests, future public manifests, future per-recipient envelopes — all share the same plaintext-derived identity), so a Sia URL rewrite is a no-op for the cache. The same `Uint8Array` reference flows through `useItemBlobURL` to the rendered media element and there's no flash on re-render. Soft cap is `min(500 MB, 25 % of navigator.storage.estimate().quota)`, LRU eviction. First fetch hits Sia hosts; reload-and-rerender is sub-millisecond.
- **Background upload queue** (`stores/uploadQueue.ts`) — `Compose*` enqueues a task and resets the form; the runner serializes tasks, surfaces shard-upload progress in the right sidebar, supports retry on failure. Publish never blocks the UI.
- **JetStream live updates** (`core/jetstream.ts`) — WS subscription to Bluesky's JetStream firehose, filtered to the DIDs of your subscribed channels. Commit events trigger per-channel manifest re-fetches. Region (us-east / us-west) is timezone-derived. Reconnect uses exponential backoff and triggers a full refresh on rejoin.
- **Storage hygiene runners** (`useUploadRunner` eager-pack path, `core/repack.ts` + `useRepackRunner`, `core/orphanSweep.ts` + `useOrphanSweep`) — three runners keep `pinnedData` honest. **Eager packing** at upload time bin-packs every byte source for a task (body + attachments, or all dropped files in a single intake) into one shared slab via `uploadPacked` — a post + 3 attachments costs 1 slab, not 4. **The repack runner** triggers on every pin event (upload-queue success, pinStore growth), walks scope (own-channel items + their attachments + cover art + library + external pins, deduped by Sia object ID), picks a greedy bin-packed batch of sub-full slabs (≥3 candidates, <80% full each, newest-object age ≥2 min), re-uploads packed, swaps URLs in affected channel manifests (item `publishedAt` preserved — repack is housekeeping, not republish), deletes old objects, calls `pruneSlabs`. Loops until clean. **The orphan sweep** runs once on app load after manifests and pinStore settle (with a 5 s defer + manifest-loaded + uploads-idle gates), walks `objectEvents` to enumerate every pinned object in your scope, diffs against the known set (channel item bodies + their attachments + cover art + library + external pins + settings), deletes the leftovers, prunes. Settings get two protections — explicit ID in the known set plus a metadata-shape skip (`kind === 'pin:settings'`) — so channel keys are never at risk. A 5-minute age gate keeps in-flight uploads exempt. The `Box` icon next to "My Storage" lights up while any of these are working.

```
src/
  core/        # platform-agnostic: Sia + ATProto calls, channel crypto, manifest, feed, jetstream, pin
  components/  # web UI (React)
  stores/      # Zustand — auth, feed, pin, upload queue, compose (armed-link state), toast
  lib/         # constants, item cache, markdown, time helpers, app bridge, hooks
```

`core/` doesn't import React, DOM, or `localStorage`. A future React Native client (using `react-native-sia`) can be a new UI layer over the same module — the Sia and ATProto plumbing transfers unchanged.

## App host API

A program-as-attachment — `text/html` bytes carried as an attachment on a post — is one of the more interesting consequences of the architecture. The program is content-addressed, encrypted, and distributed by exactly the same machinery as a JPEG: it travels like media. Pong and Snake, both included as bundled examples ([`examples/pong/`](examples/pong/), [`examples/snake/`](examples/snake/)), ship in a channel as small HTML files attached to posts, that you can subscribe to, fetch, and run inline. Where it gets interesting is what an app should and shouldn't be able to *do* — that surface is barely sketched today.

Apps run inside an iframe with `sandbox="allow-scripts allow-modals allow-pointer-lock"`. The sandbox blocks network, popups, top-navigation, forms, and same-origin access — an app can compute, render, and accept input, but can't reach our DOM, our keys, the user's other tabs, or any external service. Anything an app needs from the outside has to come through a `postMessage` channel the host explicitly proxies. **That's the permission boundary**: the host decides which capabilities it exposes as RPCs, and apps are free to use only those.

### Today's shape

One RPC pair: per-app local state. Null-origin iframes don't get their own `localStorage`, so the host exposes get/set so apps can persist things like high scores, save games, or preferences. State is scoped by `appID` (the attachment's Sia object ID, falling back to its content hash, falling back to its share URL — same identity the pin-and-orphan-sweep machinery uses), so the same bytes share state across whichever posts attach them. Storage is local to the device; not synced across devices (yet). The protocol's `dispatch:` message-type prefix predates the app's rename and is preserved so that already-published apps continue to work.

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

1. **Host-as-proxy (the current shape).** The host has the SDK; the app makes typed `postMessage` requests; the host executes and returns the result. Permission lives at the RPC boundary — we approve or deny each call individually. Simple to reason about. The API the app sees isn't shaped like the SDK; it's shaped like whatever message types we choose to expose.

2. **SDK-as-contract.** The app imports a shim that *looks* like the SDK (`await sdk.upload(...)`), and the shim marshals each call over `postMessage`. The host implements the SDK on the app's behalf. App code reads like ordinary SDK usage; permission still lives at the host boundary, but the contract is the SDK itself. This is the cleanest shape if we ever want apps to be portable to other host environments — a desktop runtime, a different web client, a CLI — without rewriting them.

3. **AppKey-per-app.** Sia's existing `AppKey` *is* the permission primitive — every authenticated session is scoped to one, and the indexer already enforces per-AppKey storage caps (`maxPinnedData`, `remainingStorage`). We could derive a sub-AppKey deterministically from `(user-AppKey, appID)`, let the app run a real SDK instance against that sub-key, and have the user approve a storage cap at install time. The sandbox still blocks raw network, but the host could expose just enough of a network shim for the app's SDK to reach the indexer — gated by the sub-AppKey's authorization. The most federated shape: each app becomes a first-class Sia identity, with its own quota and an isolated pinned set, separate from the host user's.

The third shape is architecturally interesting because **Sia already has the permission primitive — we don't need to invent one**. Storage cap, isolated pinned set, all derivable from a root identity. We'd be making the AppKey hierarchy one level deeper, and the existing indexer enforcement comes along for free. Pin currently runs shape #1 because it was the smallest thing that worked for pong's hi-score; future thinking probably starts at #3.

### What's open

Pong is one example; the broader question — what *should* an app be able to do — is barely explored. Every capability beyond pure compute is a host-side permission decision, and none of them are settled. A non-exhaustive list of open questions, in roughly increasing order of risk:

- **Read other items in the same channel.** Useful (an app could render its own playlist over audio items in the channel), low risk.
- **Read the manifest's metadata** (channel name, description, item refs). Same shape — useful for context-aware apps.
- **Upload a new item to its own channel.** Only meaningful if the running user owns the channel; needs an explicit "this app wants to publish on your behalf" prompt to avoid vandalism.
- **See the user's pinned set.** Privacy concern; probably no by default.
- **Sign with the user's `AppKey`.** Identity proxy — powerful and dangerous; needs explicit per-call consent UI.
- **Pin a URL the app constructs.** Storage-cost vector against the user's Sia allowance; needs consent and probably a size cap.

The framing that makes this tractable: apps can't reach Sia or ATProto directly. Anything they do goes through host RPCs. So designing the App Host API is the same exercise as designing a permission surface over the Sia SDK — *which calls are safe to proxy, under what consent model, at what scope*. Today's answer: compute and your own state, nothing else. Growing that surface is the open question.

## Editing and drift

Authors edit their own posts via the **Edit** button on a post they own. The composer reopens with the post's body and attachments pre-loaded; **Save** runs the same upload-then-swap-manifest path as publish, preserving `publishedAt` so the edit stays in its original chronological position. The feed row and Read page show an inline `· edited` timestamp next to publish time when an edit has landed.

Pinned copies on subscribers' devices are **snapshots** — frozen at the moment of pinning. An author's edit changes the manifest's pointer to new Sia bytes; the subscriber's pinned bytes don't move. That's the architectural promise of "K is custody, not authorship": reader pins are fixed-in-time stewardship. The pin icon makes drift legible — a small green dot at the top-right of a pinned post indicates that your snapshot differs from the channel's current version. On the Read page, a **View yours** toggle swaps the rendered body and attachments between the channel's current and your pinned snapshot. Re-clicking pin on a drifted post updates your snapshot to the current version — single custody snapshot, swapped to the new bytes.

If an author retracts a post, subscribers' pinned copies persist. The Read page for a retracted item surfaces an inline notice and renders the pinned snapshot — the channel has no current version to show. The retract intent is honored in the feed (the post disappears via the JetStream manifest update); the custody story is told at the moment the subscriber engages with their copy.

Identity, deliberately: a post is matched to its prior version by the preserved `publishedAt` on the same channel, not via a separate persistent identifier. No `logicalID` primitive — that would let share URLs silently follow author edits, shifting power against the "what you share is what you share" trust contract. Records, not logical posts.

## Tests

Three-tier pyramid. `bun run test` runs all three; each tier also has its own command.

| Tier | Command | Speed | Backed by |
|---|---|---|---|
| Unit | `bun run test:unit` | ~3s | No SDK at all. Pure-logic tests for `core/*`: crypto, content-hash, jetstream endpoint-picker, feed collation, pin-state transitions. Vitest + jsdom. |
| Integration | `bun run test:int` | ~3s | In-memory fakes — `FakeSdk`, `FakeAgent`, `FakeRecordStore`, `connectFakeJetstream`. Drives the real React components ([HomeFeed](src/components/HomeFeed.tsx), [PinButton](src/components/PinButton.tsx), etc.) through the upload / pin / drift / retract flows. Two simulated accounts in one Node process; cross-account custody is testable in milliseconds. |
| E2E | `bun run test:e2e` | ~50s | Real Sia hosts + real bsky.social, driven by Playwright Chrome against the built `dist/` (preview server). One happy-path test: alice creates a channel and publishes; bob subscribes via URL and sees it. |

The shape is **fake-vs-real by layer**, not by test. Unit has no SDK; integration runs against fakes for speed and determinism; e2e runs against the real network in a tiny tier (~3-5 tests). The e2e tier's job is to be **the reconciliation point for the fake-SDK contract** — if the fakes drift from real Sia / ATProto behavior, that test fails and we fix the fakes. The integration tier can grow into the hundreds confidently; the e2e tier stays small.

E2E auth is real, with credentials in a gitignored `e2e/.env.test`. The Sia side uses a one-time-captured AppKey hex; the Bluesky side scrapes the bsky.social OAuth UI deliberately — when their UI changes, the test fails loudly as signal. Per-account setup is documented in [e2e/README.md](e2e/README.md).

## Roadmap

- **Per-recipient access control + revocation.** Pin currently treats subscribe URLs as universal access — anyone with the URL has equal read, same model as Sia's `shareObject`. The plan: per-subscriber NaCl box envelopes via a separate ATProto record collection, with key rotation on removal.
- **Notifications, replies, likes, mentions, threads.** Intentionally absent. Not on the roadmap either — conversation by inference, not threading.
- **Native mobile.** `core/` is platform-agnostic and ready. Pin currently ships the web SPA only; a React Native client built on `react-native-sia` is the path.
- **Granular pinning — the post vs the file.** Today's pin verb mirrors a whole post (body + every attachment) into your Sia scope. Future: distinct verbs for pinning the message (the post structure, author, channel context) and pinning specific attachment files. Content-addressing already supports it — two posts referencing the same bytes share storage, so pinning a file via post A keeps it alive for any other post referencing the same hash. The split lines up with the architectural commitment: a post is something you authored; a file is bytes that exist. A text-only post has nothing separable to pin-as-file, so the second verb only manifests when there's a file in the wrapper.
- **Pagination, drafts, AppView discovery.** Single-page manifest, single channel-key per channel — none of these are here yet.
- **Settings slab reclaim.** Settings are written through `sdk.upload` (not `uploadPacked`) and live in their own dedicated ~40 MiB slab. Architecturally the price of a separately-discoverable settings record (the orphan sweep finds it via `kind === 'pin:settings'` metadata and explicitly protects it). Could be reclaimed by either packing settings alongside other writes or accepting the overhead as the cost of an easy-to-find, never-deletable record. Not urgent.
- **Persistent upload queue.** Tab close during a slow upload drops the pending bytes. The fix: store task bytes in IndexedDB by task UUID so the queue resumes across reload.
- **Channel export / import (manifest portability).** A small JSON file containing `{ channelKey, channelID, manifest }` is the entire backup image of a channel. The plan: **Download manifest** + **Import manifest** affordances. Import walks every item URL and re-pins the bytes into the importer's indexer scope (mandatory because each AppKey is a distinct pinned-objects scope), then republishes the manifest under the importer's DID. Same-user import = clean migration (AppKey rotation, cross-device portability). Different-user import = fork, surfaced as an explicit verb with a `forkedFrom` provenance field. The framing: **`K` is custody capability, not authorship credential.**
- **Parallel attachment uploads.** The runner currently uploads attachments sequentially (one shard stream at a time, in source order). Parallel would be faster for multi-file posts but adds bookkeeping (per-source progress, error aggregation). Earns its keep when a real "this felt slow" moment shows up.
- **Follow the person, not just the channel.** Today Pin only has channel-follow (`dev.sia.pin.subscription` records with channel AT-URIs as subject). A `dev.sia.pin.handlefollow` primitive would let you follow a *person* by their DID — auto-tracking any new channels they later advertise on their profile. Two psychological commitments, two real verbs: "I want this voice's direct output" (channel-follow) and "I want this person's whole identity" (handle-follow).
- **Channel types — Twitter-shape, Reddit-shape, more.** Every channel today is the calm-feed shape. The architecture composes with multiple experiences over the same substrate (Twitter-style likes / re-pins / quote-posts, Reddit-style topic threads with nested comments, others). When that ships, channels carry a `type` field and clients render per-type.
- **Comments.** Stand-off pattern: a commenter writes a record to their own repo with subject = strong ref to the post + body = Sia URL pointing at the comment bytes. Records on atproto for discovery, bytes on Sia for content — symmetric with how Pin already handles channels.

## Run it locally

If you'd rather clone than click. Requires [Bun](https://bun.sh) and Chrome.

```sh
bun install
bun run dev
```

Open `http://127.0.0.1:5173` in Chrome. (Vite binds to the loopback IP rather than `localhost` because atproto OAuth's RFC 8252 redirect rules forbid the `localhost` hostname; the app auto-redirects you if you hit the localhost URL.) The first-time flow opens at a welcome screen with two paths: **Get started** routes through Bluesky sign-in first (OAuth — you redirect to bsky.social, authorize there, come back signed in) then through Sia approval (Connect → Approve at sia.storage → save Recovery phrase → connected); **Just reading** skips Bluesky and goes straight to Sia approval. Bluesky can also be added lazily later from inside the app the first time you try to create or publish.

A note on browser support: we pinned `@siafoundation/sia-storage` early and built against Chrome throughout the 3-day window. Cross-browser validation was out of scope — Chrome was the target, it was green from day one, and we kept iterating. The app may run elsewhere, but Chrome is the only environment we exercised.

## Credits

Pin sits on infrastructure built by other people:

- **My colleagues at the [Sia Foundation](https://sia.tech)** maintain [the libraries](https://github.com/SiaFoundation) advancing the broader [Sia network](https://sia.tech): [Luke Champine](https://github.com/lukechampine), [Nate](https://github.com/n8mgr), [Christopher Schinnerl](https://github.com/ChrisSchinnerl), [Peter-Jan Brone](https://github.com/peterjan), [Christopher Tarry](https://github.com/chris124567), [Alrighttt](https://github.com/Alrighttt), and [Alex Freska](https://github.com/alexfreska).
- **[ATProto](https://atproto.com) and [Bluesky](https://bsky.app)** for the protocol and the public infrastructure (PDS, [JetStream](https://github.com/bluesky-social/jetstream) relay) that handle Pin's mutable channel-naming layer. `@atproto/api` for client calls; the JetStream firehose for sub-second live updates without polling.

Scaffolded from [SiaFoundation/create-sia-app](https://github.com/SiaFoundation/create-sia-app) by [Alex Freska](https://github.com/alexfreska).
