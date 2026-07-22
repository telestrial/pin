# Pin

Decentralized personal feeds. Channels you own, subscriptions you pick, no platform between author and reader.

https://github.com/user-attachments/assets/cba3bc35-934c-4e58-a372-1358824e49f2

## What it does

A **channel** is a publishing handle — a person, a persona, a topic, a project. You own as many as you want and subscribe to others' by pasting a URL. The thing you publish is a **post** — short plaintext (281 characters, one more than Twitter, intentional), optionally with attachments (images, audio, video, files, or HTML apps that run sandboxed inline) shown beneath the body. Your home is a chronological mix from every channel you've subscribed to. When something's worth keeping, **pin it** — pinning mirrors the bytes into your own Sia storage so your copy survives even if the original publisher unpins. It's the verb the app is named after.

## Why it's cool

There is no Pin server, no Pin database, no company between authors and readers. Item bytes live on Sia, encrypted with per-object keys. A channel's current state is an encrypted manifest — also a Sia object — found through a signed pointer published to a public DHT (Mainline, via pkarr) under a key derived from the channel's secret `K`. `K` never leaves the URL fragment of the subscribe link: holding it lets you *find* the channel (derive the pointer) and *read* it (decrypt the manifest). Your identity is a `did:dht` derived from your Sia recovery phrase — self-sovereign, no account rented from anyone. A reader who pins becomes a host of those bytes — Sia gets stronger for that channel as more readers commit. An author can retract from their own storage, but a subscriber's pinned copy persists. Twitter delete is unilateral; Pin retract is custody being released.

## Demo flow

### ▶ [pin-liard.vercel.app](https://pin-liard.vercel.app/)

Best in Chrome. Best with a friend — pair up, each open the URL on your own machine, walk through it together. One of you plays the author, the other the subscriber. (Solo? Two browser windows on one machine, Incognito for the second so the Sia accounts stay distinct.)

1. **Both of you**: finish onboarding — approve at sia.storage, save your recovery phrase, then pick a name for yourself. That's it; your identity is a `did:dht` derived from that phrase, no account to create anywhere.
2. **Author** (one of you): click **+ Create a channel**, give it a name and (optionally) a cover image. Copy the subscribe URL — it's `pin://did:dht:…#k=…`, the channel's identity plus its secret key — and send it to the subscriber.
3. **Subscriber** (the other): click **+ Subscribe** and paste the author's URL. The channel resolves — Pin derives the DHT pointer from `K`, fetches the encrypted manifest from Sia, and decrypts it.
4. **Author**: publish from the inline composer at the top of the feed. The composer is one line at rest — click it and it expands. Type your post (up to 281 characters), and **drag a file onto the composer** to attach it (image / audio / video / file) below the body. Click Publish — the form clears immediately, and the **upload queue** in the right sidebar takes over, uploading the attachment bytes then the body bytes, then publishing the updated channel pointer to the DHT. The UI never blocks.
5. **Subscriber**: hit **Refresh**. The new post appears — the channel pointer on the DHT is eventually-consistent, so a fresh publish shows up within seconds. (A channel that momentarily fails to re-resolve keeps its last-known content rather than blanking out.)
6. **Pin moment.** **Subscriber**: hover an item and click the pin icon. The item is now mirrored into your Sia storage; the right sidebar's bar ticks up and the item appears in **Pinned**. Then the **author**: click the (filled, owned-author-green) pin icon on the same item and type `DELETE` to retract. The item disappears from the author's feed and storage — but the subscriber's pinned copy persists, with a working share URL. That's custody at work.

---

The rest of this README goes deeper: the specific Sia SDK calls Pin uses (and where), the architecture, the sandboxed App Host API, the roadmap, and how to run locally if you want to clone instead of clicking the link above.

## Sia SDK usage

Pin uses [`@siafoundation/sia-storage`](https://www.npmjs.com/package/@siafoundation/sia-storage) load-bearingly:

| SDK call | Where it's used |
| --- | --- |
| `Sdk` instance per user | Every authenticated session ([core/sia.ts](src/core/sia.ts), AppKey approve flow from `create-sia-app`) |
| `sdk.upload(new PinnedObject(), Blob.stream())` | Post body bytes, every attachment file on a post, channel cover art, profile avatar / cover image bytes. The composer never blocks on upload — bytes get pushed to Sia by the background runner after Publish, then the manifest is written with the resolved URLs. |
| `sdk.pinObject(obj)` | Durability for items you publish (body + each attachment); mirroring a friend's whole post (body + every attachment) into your storage when you pin it; mirroring just **one attachment file** into your Library on its own (the post vs the file are separate custody relationships — *a post is something you authored, a file is bytes that exist*); and **channel-level pin** — a snapshot that fans the same mirror out over every item in a channel, with per-item progress shown in the right sidebar and the header pin filling as it goes. Re-pinning a channel catches up newly-published items |
| `sdk.shareObject(obj, validUntil)` | Per-item distribution URL with the per-object encryption key in the URL fragment; year-9999 expiries verified safe |
| `sdk.sharedObject(url)` | Resolves a shared URL into a `PinnedObject` handle. Used before downloading (subscriber reads) and before mirroring (pinning a friend's item — `sharedObject` then `pinObject` adds the bytes to your indexer scope) |
| `sdk.download(obj)` (as `ReadableStream`) | Subscriber reads (cached in IndexedDB after first fetch — see Architecture) |
| `sdk.deleteObject(id)` | Retraction at three granularities: a single **attachment** (drop one file from your post), a whole **item** (typed-`DELETE` on your own post), and a whole **channel** (**Unpin channel** walks every item, then deletes the manifest objects; the DHT pointer expires by TTL). Retraction is **eager and reference-safe** — a decision you made frees the bytes immediately, but skips any object still referenced by another of your posts or a pin (content-addressing means the same file can be shared). A subscriber's unpin is reference-aware the same way (a file held by both a whole-post pin and a standalone file pin survives until the last holder lets go). Subscribers who mirrored items keep their independent copies |
| `sdk.uploadPacked()` + `packed.add(stream)` + `packed.finalize()` | Bin-packed multi-object uploads. Composer tasks (post body + attachments) and drag-drop intake into My Storage share a single ~40 MiB slab rather than one slab per object. Same call powers the background repack runner that consolidates sub-full slabs after the fact |
| `obj.slabs()` | Per-object slab inventory (`encryptionKey`, `offset`, `length`, `sectors`). The repack runner reads this to compute fill levels and pick consolidation batches; the SlabInspector debug view uses it for the per-slab object listing |
| `sdk.objectEvents(cursor, limit)` | Paginated walk of every pinned object in scope. Used to total raw content bytes for the storage meter, by the repack runner to inventory slabs, and by full-reset to enumerate every object to delete |
| `sdk.pruneSlabs()` | Releases unused slab capacity after `deleteObject`. The indexer doesn't auto-drop empty slabs, so without this `pinnedData` stays inflated even after deletes succeed. Called at the end of every repack batch — load-bearing for the bar to actually fall |
| `sdk.account()` | The storage card at the top of the right sidebar — `pinnedData / maxPinnedData`, refreshed on every pin / unpin / retract / repack |
| `sdk.appKey().publicKey()` | Recorded inside the encrypted channel manifest as the technical author identity |
| `AppKey` export bytes → HKDF | The one root secret. The Sia AppKey (recovered from the recovery phrase) is the seed for everything else: the channel-manifest encryption, the settings-snapshot key, and — via domain-separated HKDF — the identity's `did:dht` keypair. One phrase reconstructs the whole self-sovereign identity. |

The naming + mutability layer — the half Sia doesn't aim to solve on its own — is handled with **no company in the path**. Each identity is a `did:dht` (an ed25519 key derived from the Sia recovery phrase). Its **identity document** (profile, advertised channels, follow edges) and each **channel's locator** (a pointer to the current manifest object) are published as signed records to the **public Mainline DHT** via [pkarr](https://github.com/pubky/pkarr) — resolved directly from the browser through a pkarr relay, verified by signature, no PDS and no OAuth. Mutable state that used to live on ATProto now lives as these signed DHT pointers into content on Sia.

## Architecture

```
Item bytes (per item)          Channel state (per channel)
        │                               │
   Sia object              pkarr record on Mainline DHT
   (encrypted via          (signed pointer, key derived from K)
    per-object URL                      │
    fragment key)                       ▼
        │               Sia object = ChannelManifest{name, description, items[]}
        │                       (AES-GCM-256 ciphertext under K)
        └────────── itemURL ──────────► (item URLs live inside the manifest)

   channelID = base32(sha256(K)).slice(0,16)
   K lives only in the subscribe URL fragment — it both locates
   (derives the DHT pointer) and decrypts (the manifest)
```

- **Channel manifest** is a Sia object, AES-GCM-256 ciphertext under `K`. Its *location* (the current object's share URL) is published as a signed [pkarr](https://github.com/pubky/pkarr) record on the public Mainline DHT, under a key derived from `K` (HKDF `pin:channel-locator:v1`). Publishing a new post writes a new manifest object and re-points the DHT record; readers re-resolve on refresh. Because the pointer is content the author signs and the DHT is eventually-consistent, a just-published change appears within seconds.
- **Channel ID** is derived from `K` (`base32(sha256(K))[:16]`), not stored separately. Since the locator key is *also* derived from `K`, only a holder of `K` can even find the channel on the DHT — obscure channels are structurally unlistable.
- **Subscribe URL** is `pin://<did:dht>#k=<base64-K>`: the author's self-sovereign identity plus the channel secret. Sharing it grants both find (derive the locator) and read (decrypt the manifest).
- **Channel visibility** is `'obscure' | 'public'`, set at creation and sticky. **Public** channels are advertised in the author's identity document (name + `K`), so anyone who resolves the author can find and read them. **Obscure** channels are absent from the identity doc — reachable only by someone holding the subscribe URL, since without `K` you can't derive the locator at all.
- **Item URLs** (which themselves contain Sia's per-object encryption keys in their fragments) are stored *inside* the encrypted manifest, so reading items requires `K`.

**Identity layer.** A person's identity is a **`did:dht`** — an ed25519 key derived from their Sia recovery phrase (HKDF), the same key whether they're on the web app or a future desktop node. No account, no company, no atproto handle in the path. Everything below hangs off it:

- **Identity document** — a Sia blob (profile + advertised public channels, each with its `K` + `name` + channelID, + follow edges) pointed at by a signed pkarr record under the `did:dht` key. Public by capability: resolving someone's `did:dht` returns their directory. Replaces the atproto profile + follow records with one signed DHT-pointed document.
- **Self-chosen handle.** The profile's `username` is the name a person picks for themselves — shown as `@name` across feeds, channel headers, and the directory. It's deliberately **non-unique and mutable**: identity is the `did:dht`, so the handle carries no structural weight — channel IDs, subscribe URLs, and follow edges all key on the DID or `K`, never the handle string. Two people can hold the same `@name`; you tell them apart by context. Where a person hasn't set one, a short form of their `did:dht` stands in.
- **Follow edges** live in the identity document as `{ didDht, channelID }` (channel-follow, no `K` — a public discovery pointer). To resolve one, you fetch the target author's identity doc and look the channelID up in their advertised channels (where public channels carry `K`). Same stand-off idea as Bluesky's follows — each edge is the follower's own signed record — but published in the one signed doc, no central index.
- **Handle directory.** Clicking any identity anywhere opens its directory: resolve the `did:dht` → its identity doc → a profile header (avatar + cover + displayName + bio, plus a Following count), the channels it advertises rendered as cover-forward hero cards, and a **Following** section from its follow edges. On your own directory a Create-a-channel affordance sits above the cards. Reached via in-app navigation; the directory is *how Pin renders any identity a user encounters in-app*.
- **Watch vs Follow.** Subscribing via the `pin://<did:dht>#k=<K>` URL is Watch — purely local state, works for both obscure and public channels. Clicking Follow on a public channel adds a public follow edge to *your* identity document; that's the signal directory pages walk. Two psychological commitments, two real verbs.
- **Follow the channel vs follow the person.** Channel-follow (above) tracks one voice's output. **Handle-follow** tracks a whole identity: it auto-Watches every public channel that identity currently advertises and picks up new ones later (reconciled on load). Unfollowing sweeps all their feeds back out. A channel you explicitly unsubscribe stays gone even while you still follow the person — a tombstone set (synced in your settings so it holds across devices) keeps the reconcile from re-adding it.

**Performance layers — none of these are Sia, all of them shape how it feels.**

- **Local IndexedDB cache** (`lib/itemCache.ts`) — every item byte fetch goes through a cache keyed on the item's plaintext **CIDv1 content hash** (`core/contentHash.ts`), with `itemURL` as the fallback for legacy items written before the hash field existed. The hash is stable across repack URL swaps and across encryption regimes (today's K-encrypted manifests, future public manifests, future per-recipient envelopes — all share the same plaintext-derived identity), so a Sia URL rewrite is a no-op for the cache. The same `Uint8Array` reference flows through `useItemBlobURL` to the rendered media element and there's no flash on re-render. Soft cap is `min(500 MB, 25 % of navigator.storage.estimate().quota)`, LRU eviction. First fetch hits Sia hosts; reload-and-rerender is sub-millisecond.
- **Action journal** (`stores/actionQueue.ts` + `lib/actionQueuePersist.ts` + `lib/actions/*` handlers + `useActionRunner`) — every state-changing mutation is a durable Action with one lifecycle: pending → running → success, or → failed (retryable), or user-dismissed. `Compose*` enqueues a `publish` action and resets the form; the runner serializes actions, dispatches each to its per-kind handler, surfaces shard-upload progress in the right sidebar. The UI never blocks. The journal is **persisted to IndexedDB and resumes across reload** — an action interrupted mid-flight (tab close, crash) picks back up on next load. For a publish: flaky-leg-first (upload bytes → **checkpoint** the resolved refs → commit the manifest + publish the DHT pointer), so a manifest never points at bytes that didn't land and a Sia outage fails fast before anything commits; the resume reads the checkpoint and skips straight to the manifest write instead of re-uploading, and per-channel progress is recorded so a multi-channel post that crashed mid-fan-out finishes only the channels it hadn't reached. Checkpointed-but-unpublished bytes are protected from the repack runner (it won't move them) until the action — or a later retry — finishes referencing them. `publish` is the first kind; deletes / retracts / edits join the journal as further kinds.
- **Read-on-refresh + stale-while-revalidate** (`core/feed.ts`, `stores/feed.ts`) — there's no live push (that was JetStream, which left with atproto). Refreshing re-resolves each subscribed channel's DHT locator → current manifest. Because Mainline is eventually-consistent, a channel that momentarily fails to re-resolve keeps its last-known manifest instead of dropping out of the feed; a subtle "Refreshing…" line shows a background re-resolve over already-visible content. A real-time push primitive for the `did:dht` world (keeper gossip / pkarr-watch) is future work.
- **Storage hygiene runners** (`useUploadRunner` eager-pack path, `core/repack.ts` + `useRepackRunner`) — two runners keep `pinnedData` honest. **Eager packing** at upload time bin-packs every byte source for a task (body + attachments, or all dropped files in a single intake) into one shared slab via `uploadPacked` — a post + 3 attachments costs 1 slab, not 4. **The repack runner** triggers on every pin event (upload-queue success, pinStore growth), walks scope (own-channel items + their attachments + cover art + library + external pins, deduped by Sia object ID), picks a greedy bin-packed batch of sub-full slabs (≥3 candidates, <80% full each, newest-object age ≥2 min), re-uploads packed, swaps URLs in affected channel manifests (item `publishedAt` preserved — repack is housekeeping, not republish), deletes old objects, calls `pruneSlabs`. Loops until clean. Reclamation is **positive-identification only** — every object Pin deletes is one it explicitly retracted or repacked; there is no scan-and-delete-the-unrecognized pass (that shape is a deny-by-absence GC whose failure mode is mass deletion, so it's deliberately absent). The `Box` icon next to "My Storage" lights up while either runner is working.
- **Settings durability** (`lib/hooks/useSettingsSync.ts`, `lib/hooks/useSettingsDocsMirror.ts`, `lib/docsMirror.ts`) — your channel list and subscriptions (and the channel keys inside them), your profile and follow edges, plus identity-wide UI preferences like the visual theme, are mirrored to a single **encrypted snapshot on Sia**, keyed on the Sia AppKey. The snapshot is the canonical durable store: its encryption key is **derived from the AppKey via HKDF** (`pin:docsnapshot:v1`, never shared), so it survives a localStorage wipe and recovers from the Sia recovery phrase alone — localStorage is just a fast cache in front of it. Writes are flushed durably before an operation that must persist reports done (channel create / subscribe / unsubscribe await the flush), killing the reload-within-a-debounce-window resurrection bug that content-addressed settings used to have. On boot, settings load straight from the snapshot — no atproto, no session required.

```
src/
  core/        # platform-agnostic: Sia calls, channel crypto, manifest, feed, profile, pin
  components/  # web UI (React)
  stores/      # Zustand — auth, feed, pin, action queue, compose (armed-link state), toast
  lib/         # constants, item cache, markdown, pkarr + did:dht + channel-locator + identity-doc, hooks
```

`core/` doesn't import React, DOM, or `localStorage`. A future React Native client (using `react-native-sia`) can be a new UI layer over the same module — the Sia and did:dht plumbing transfers unchanged.

## App host API

A program-as-attachment — `text/html` bytes carried as an attachment on a post — is one of the more interesting consequences of the architecture. The program is content-addressed, encrypted, and distributed by exactly the same machinery as a JPEG: it travels like media. Pong and Snake, both included as bundled examples ([`examples/pong/`](examples/pong/), [`examples/snake/`](examples/snake/)), ship in a channel as small HTML files attached to posts, that you can subscribe to, fetch, and run inline. Where it gets interesting is what an app should and shouldn't be able to *do* — that surface is barely sketched today.

Apps run inside an iframe with `sandbox="allow-scripts allow-modals allow-pointer-lock"`. The sandbox blocks network, popups, top-navigation, forms, and same-origin access — an app can compute, render, and accept input, but can't reach our DOM, our keys, the user's other tabs, or any external service. Anything an app needs from the outside has to come through a `postMessage` channel the host explicitly proxies. **That's the permission boundary**: the host decides which capabilities it exposes as RPCs, and apps are free to use only those.

### Today's shape

One RPC pair: per-app local state. Null-origin iframes don't get their own `localStorage`, so the host exposes get/set so apps can persist things like high scores, save games, or preferences. State is scoped by `appID` (the attachment's Sia object ID, falling back to its content hash, falling back to its share URL — same identity the pin-and-repack machinery uses), so the same bytes share state across whichever posts attach them. Storage is local to the device; not synced across devices (yet). The protocol's `dispatch:` message-type prefix predates the app's rename and is preserved so that already-published apps continue to work.

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

The framing that makes this tractable: apps can't reach Sia directly. Anything they do goes through host RPCs. So designing the App Host API is the same exercise as designing a permission surface over the Sia SDK — *which calls are safe to proxy, under what consent model, at what scope*. Today's answer: compute and your own state, nothing else. Growing that surface is the open question.

## Editing and drift

Authors edit their own posts via the **Edit** button on a post they own. The composer reopens with the post's body and attachments pre-loaded; **Save** runs the same upload-then-swap-manifest path as publish, preserving `publishedAt` so the edit stays in its original chronological position. The feed row and Read page show an inline `· edited` timestamp next to publish time when an edit has landed.

Pinned copies on subscribers' devices are **snapshots** — frozen at the moment of pinning. An author's edit changes the manifest's pointer to new Sia bytes; the subscriber's pinned bytes don't move. That's the architectural promise of "K is custody, not authorship": reader pins are fixed-in-time stewardship. The pin icon makes drift legible — a small green dot at the top-right of a pinned post indicates that your snapshot differs from the channel's current version. On the Read page, a **View yours** toggle swaps the rendered body and attachments between the channel's current and your pinned snapshot. Re-clicking pin on a drifted post updates your snapshot to the current version — single custody snapshot, swapped to the new bytes.

If an author retracts a post, subscribers' pinned copies persist. The Read page for a retracted item surfaces an inline notice and renders the pinned snapshot — the channel has no current version to show. The retract intent is honored in the feed (the post disappears when the feed re-resolves the channel); the custody story is told at the moment the subscriber engages with their copy.

Identity, deliberately: a post is matched to its prior version by the preserved `publishedAt` on the same channel, not via a separate persistent identifier. No `logicalID` primitive — that would let share URLs silently follow author edits, shifting power against the "what you share is what you share" trust contract. Records, not logical posts.

## Mentions

Typing `@` in the composer opens a picker of people reachable through your network — the authors of channels you hold (call it R0), plus the people *they* follow (R1, walked from the follow edges in their identity docs). Pick someone and it splices `@name` into the body and records a **facet**: a byte range on the `ItemRef` annotated with `{ $type: 'pin.mention', did }`. Because Pin handles are non-unique, a name alone can't identify a person — so the `did:dht` travels with the mention. The picker disambiguates candidates by name and stores the key.

The body stays clean plaintext (`@name`); the facet is parallel side-data. At render, each facet's range becomes a tappable green `@name` link over the markdown — the visible text is a snapshot of what the author picked (it isn't re-resolved, so it can't break when someone renames), and clicking navigates by handle to that person's directory. Navigation everywhere keys on the DID/handle, never the non-unique display name.

Reach is a parameter: the network walk carries a hop depth (R0 + R1 today), so widening discovery later doesn't change the picker or the stored facet. Notifying the mentioned person is future work; the facet authored now is the foundation it builds on.

Three-tier pyramid. `bun run test` runs all three; each tier also has its own command.

| Tier | Command | Speed | Backed by |
|---|---|---|---|
| Unit | `bun run test:unit` | ~3s | No SDK at all. Pure-logic tests for `core/*` and `lib/*`: crypto (incl. the HKDF key derivations), content-hash, feed collation, pin-state transitions, network-reach walks, word-boundary + mention facets. Vitest + jsdom. |
| Integration | `bun run test:int` | ~3s | In-memory fakes — `FakeSdk` plus a fake pkarr/DHT layer on the shared `FakeWorld`, so channel-locator publish/resolve round-trips without the network. Drives the real React components ([HomeFeed](src/components/HomeFeed.tsx), [PinButton](src/components/PinButton.tsx), etc.) through the upload / pin / drift / retract flows. Two simulated accounts in one Node process; cross-account custody is testable in milliseconds. |
| E2E | `bun run test:e2e` | minutes | Real Sia hosts, driven by Playwright Chrome against the built `dist/` (preview server). Happy-path flows — publish / subscribe / pin cross-account, an interrupted publish resuming from its IndexedDB checkpoint on reload, granular file-pinning — serialized on one worker since they share test accounts. (Onboarding is Sia recovery-phrase only now; the specs are being updated off the old Bluesky flow.) |

The shape is **fake-vs-real by layer**, not by test. Unit has no SDK; integration runs against fakes for speed and determinism; e2e runs against the real network in a tiny tier (~3-5 tests). The e2e tier's job is to be **the reconciliation point for the fake contract** — if the fakes drift from real Sia behavior, that test fails and we fix the fakes. The integration tier can grow into the hundreds confidently; the e2e tier stays small.

E2E auth is real, with credentials in a gitignored `e2e/.env.test` — the Sia side uses a one-time-captured AppKey hex. Per-account setup is documented in [e2e/README.md](e2e/README.md).

## Roadmap

- **Per-recipient access control + revocation.** Pin currently treats subscribe URLs as universal access — anyone with the URL has equal read, same model as Sia's `shareObject`. The plan: per-subscriber encrypted envelopes so a channel key can be handed out (and rotated away) per reader rather than shared as one `K`.
- **Notifications, replies, likes, mentions, threads.** Intentionally absent. Not on the roadmap either — conversation by inference, not threading.
- **Native mobile.** `core/` is platform-agnostic and ready. Pin currently ships the web SPA only; a React Native client built on `react-native-sia` is the path.
- **Pagination, drafts, AppView discovery.** Single-page manifest, single channel-key per channel — none of these are here yet.
- **First-class uploads surface.** The upload queue is now durable user-facing state — persisted, resumable, with per-task checkpoint and per-channel publish status — but the only display is the right sidebar's In-flight strip. A dedicated Uploads view is the natural next slice: a boot-time "resuming where you left off" signal, a standing retry tray for failed uploads (which can honestly promise *"won't re-upload"* because the bytes are already on Sia), and richer per-task status ("publishing to 2 of 3 channels").
- **Channel export / import (manifest portability).** A small JSON file containing `{ channelKey, channelID, manifest }` is the entire backup image of a channel. The plan: **Download manifest** + **Import manifest** affordances. Import walks every item URL and re-pins the bytes into the importer's indexer scope (mandatory because each AppKey is a distinct pinned-objects scope), then republishes the manifest under the importer's DID. Same-user import = clean migration (AppKey rotation, cross-device portability). Different-user import = fork, surfaced as an explicit verb with a `forkedFrom` provenance field. The framing: **`K` is custody capability, not authorship credential.**
- **Parallel attachment uploads.** The runner currently uploads attachments sequentially (one shard stream at a time, in source order). Parallel would be faster for multi-file posts but adds bookkeeping (per-source progress, error aggregation). Earns its keep when a real "this felt slow" moment shows up.
- **Feed lenses (and managing who you follow).** Handle-follow ships today, but it's only reachable by navigating to someone's handle directory and clicking Follow — there's no single place to see who you follow. The direction: rather than a separate people-management view, **home stays THE feed and a lens is something you apply to it** — named, toggleable, user-chosen. "Following only" becomes the first lens; later ones could widen the feed to graph-reachable items (surfaced by provenance — *"someone you follow re-pinned this"* — not by an opaque ranker) or reorder it. The feed is the noun, the lens is the adjective; the lens *is* the people view, expressed as what reaches you. Unfollow keeps living on each handle directory.
- **Channel types — Twitter-shape, Reddit-shape, more.** Every channel today is the calm-feed shape. The architecture composes with multiple experiences over the same substrate (Twitter-style likes / re-pins / quote-posts, Reddit-style topic threads with nested comments, others). When that ships, channels carry a `type` field and clients render per-type.
- **Comments.** Stand-off pattern: a commenter keeps the comment bytes in their own Sia storage and publishes a signed pointer (subject = the post being commented on) the author can discover and aggregate — bytes on Sia, discovery via the same signed-pointer machinery channels already use, no central index.

## Run it locally

If you'd rather clone than click. Requires [Bun](https://bun.sh) and Chrome.

```sh
bun install
bun run dev
```

Open `http://127.0.0.1:5173` in Chrome (the app also serves on `127.0.0.1` and redirects you there). The first-time flow is a single path: approve at sia.storage (Connect → Approve → save your Recovery phrase → connected), then **pick a name for yourself**. That's the whole of it — your `did:dht` identity is derived from the recovery phrase, so there's no account to create and nothing to sign into. Keep the phrase safe: it's the one root secret that reconstructs your identity, your channel keys, and your settings.

A note on browser support: we pinned `@siafoundation/sia-storage` early and built against Chrome throughout the 3-day window. Cross-browser validation was out of scope — Chrome was the target, it was green from day one, and we kept iterating. The app may run elsewhere, but Chrome is the only environment we exercised.

## Credits

Pin sits on infrastructure built by other people:

- **My colleagues at the [Sia Foundation](https://sia.tech)** maintain [the libraries](https://github.com/SiaFoundation) advancing the broader [Sia network](https://sia.tech): [Luke Champine](https://github.com/lukechampine), [Nate](https://github.com/n8mgr), [Christopher Schinnerl](https://github.com/ChrisSchinnerl), [Peter-Jan Brone](https://github.com/peterjan), [Christopher Tarry](https://github.com/chris124567), [Alrighttt](https://github.com/Alrighttt), and [Alex Freska](https://github.com/alexfreska).
- **[pkarr](https://github.com/pubky/pkarr) and the [Mainline DHT](https://en.wikipedia.org/wiki/Mainline_DHT)** for the public, company-free naming layer — signed records that let a `did:dht` identity and a channel's location be published and resolved by anyone, no server in between. `did:dht` follows the [DID method](https://did.dht.dev/) built on the same substrate.

Scaffolded from [SiaFoundation/create-sia-app](https://github.com/SiaFoundation/create-sia-app) by [Alex Freska](https://github.com/alexfreska).
