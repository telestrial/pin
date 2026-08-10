/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * The namespace ids of every channel doc currently open. Lets the app avoid
 * re-importing one it already holds, and gives the Curate page something to show.
 */
export function channel_doc_namespaces(): any;

/**
 * A channel's public identifier, derived from its key. Pin's own format (a truncated
 * SHA-256 in a specific base32 alphabet), so it is derived in one place rather than
 * independently on each side — two sides disagreeing would name the same channel
 * differently and never find each other's.
 */
export function channel_id(channel_key: Uint8Array): string;

/**
 * Open a sealed manifest blob with K — the path a CACHED copy takes, so that a cached
 * read and a fresh resolve decode identically.
 */
export function channel_open_blob(channel_key: Uint8Array, blob: string): string;

/**
 * Seal a manifest under K, upload it, and publish the pointer. Returns `Published`
 * as JSON — the caller needs the object id to reclaim the generation it superseded.
 */
export function channel_publish(channel_key: Uint8Array, manifest_json: string): Promise<string>;

/**
 * Re-sign a channel's current pointer to refresh its TTL, without minting a new object.
 */
export function channel_republish_pointer(channel_key: Uint8Array, item_url: string): Promise<void>;

/**
 * Read a channel from K alone. `undefined` when the locator resolves to nothing, which
 * is ordinary — unpublished, or aged off the DHT.
 */
export function channel_resolve(channel_key: Uint8Array): Promise<string | undefined>;

/**
 * A plaintext content fingerprint (CIDv1, raw codec, SHA-256).
 *
 * Uploads already carry their own hash back from `pin-sia`, so nothing in the
 * production path calls this — it exists for bytes the app holds without having just
 * uploaded them, which today means the integration tier's fake client.
 */
export function content_hash(bytes: Uint8Array): string;

/**
 * Open a base64 blob sealed under a channel key. The plaintext is UTF-8 (a manifest's
 * JSON), so this returns it as a string.
 */
export function decrypt_for_channel(key: Uint8Array, blob_b64: string): string;

/**
 * Open a padded settings blob, returning the payload with the padding stripped.
 */
export function decrypt_settings(key: Uint8Array, blob_b64: string): string;

/**
 * Delete a record from a channel doc (author side).
 */
export function delete_channel_record(ns_id: string, collection: string, rkey: string): Promise<void>;

/**
 * Delete a record (tombstone).
 */
export function delete_record(collection: string, rkey: string): Promise<void>;

/**
 * A channel's iroh-docs namespace seed (AppKey-derived — the write capability stays
 * with the author).
 */
export function derive_channel_doc_seed(app_key: Uint8Array, channel_id: string): Uint8Array;

/**
 * The pkarr seed for a channel's read-DocTicket record, from its channel key K.
 */
export function derive_channel_doc_ticket_seed(channel_key: Uint8Array): Uint8Array;

/**
 * A channel's pkarr locator seed, from its channel key K.
 */
export function derive_channel_locator_seed(channel_key: Uint8Array): Uint8Array;

/**
 * The identity's did:dht ed25519 seed — the same value `identity.rs` derives.
 */
export function derive_did_dht_seed(app_key: Uint8Array): Uint8Array;

/**
 * Pin-record encryption key.
 */
export function derive_pinned_key(app_key: Uint8Array): Uint8Array;

/**
 * Publish-state encryption key.
 */
export function derive_published_key(app_key: Uint8Array): Uint8Array;

/**
 * The pkarr seed for one instance's rendezvous entry.
 */
export function derive_rendezvous_instance_seed(rendezvous_seed: Uint8Array, instance_id: string): Uint8Array;

/**
 * The pkarr seed for your instance-rendezvous directory.
 */
export function derive_rendezvous_seed(app_key: Uint8Array): Uint8Array;

/**
 * Settings-record encryption key.
 */
export function derive_settings_key(app_key: Uint8Array): Uint8Array;

/**
 * The pkarr seed for your settings-snapshot pointer.
 */
export function derive_settings_locator_seed(app_key: Uint8Array): Uint8Array;

/**
 * Sia whole-doc snapshot encryption key.
 */
export function derive_snapshot_key(app_key: Uint8Array): Uint8Array;

/**
 * Seal a UTF-8 string under a channel key, returning the base64 blob.
 */
export function encrypt_for_channel(key: Uint8Array, plaintext: string): string;

/**
 * Seal the settings payload, padded to a fixed size so its length carries nothing.
 */
export function encrypt_settings(key: Uint8Array, plaintext: string): string;

/**
 * Read a record from a channel doc, or `undefined` if absent.
 *
 * Author-AGNOSTIC (`single_latest_per_key`, no author filter) — deliberately. On the
 * subscriber side the entry was written by the channel owner, whose `AuthorId` we
 * don't hold and would otherwise have to publish. Safe because the capability is
 * read-only for everyone but the owner: any entry at this key IS theirs. This is the
 * simplification the read-ticket choice buys.
 */
export function get_channel_record(ns_id: string, collection: string, rkey: string): Promise<Uint8Array | undefined>;

/**
 * Read a record's bytes, or `undefined` if absent.
 */
export function get_record(collection: string, rkey: string): Promise<Uint8Array | undefined>;

/**
 * Subscriber side: import a channel's read ticket and live-sync it. Returns the
 * namespace id. `on_event(nsID, kind, key)` fires per `LiveEvent` — structured
 * rather than one string so the frontend never parses a label, and the desktop's
 * Tauri-event payload carries the same three fields.
 *
 * Uses `import_and_subscribe`, which subscribes BEFORE starting sync — so the first
 * reconciliation's events can't be missed (the initial catch-up is exactly the one
 * we most want to see).
 */
export function import_channel_doc(ticket: string, on_event: Function): Promise<string>;

/**
 * Every record in the doc, as `{collection, rkey}` pairs (JSON). Used to snapshot the
 * whole doc (docsMirror).
 *
 * The key is split HERE, by `pin_derive`'s `RecordKey`, rather than handed over raw
 * for the frontend to split — so this engine and the desktop's decompose keys with
 * one definition. Keys that aren't record keys are skipped: a whole-doc snapshot
 * shouldn't fail over one stray key.
 */
export function list_all(): Promise<string>;

/**
 * List the rkeys under a collection (entries whose key starts with `collection/`).
 * Returns a JS array of strings.
 */
export function list_records(collection: string): Promise<any>;

/**
 * Add a newly published item to the front of the channel.
 */
export function manifest_append_item(manifest_json: string, item_json: string, now: string): string;

/**
 * Shape an upload result and a draft into the item that goes in the manifest.
 */
export function manifest_build_item(uploaded_json: string, draft_json: string, now: string): string;

/**
 * Build the manifest a new channel starts life as.
 *
 * Images arrive already stored, as references inside the args — storing bytes needs a
 * connected Sia session, and which one that is differs by platform, so it stays with the
 * caller and this stays a pure build.
 */
export function manifest_create_channel(new_channel_json: string, now: string): string;

/**
 * Retract one item, returning the next manifest and the bytes nothing else references.
 */
export function manifest_delete_item(manifest_json: string, item_id: string, protected_object_ids: string[], now: string): string;

/**
 * Apply a patch to a channel's details, reporting the images it left behind.
 */
export function manifest_edit_channel(manifest_json: string, patch_json: string, now: string): string;

/**
 * Replace an item's content, keeping its place in the channel's chronology.
 */
export function manifest_edit_item(manifest_json: string, old_item_id: string, new_item_json: string, removed_attachment_object_ids: string[], now: string): string;

/**
 * Enumerate what a whole-channel retract leaves behind. `manifest_json` is empty when
 * the locator no longer resolves — a retract whose target is already gone still
 * succeeds, having nothing to enumerate.
 */
export function manifest_enumerate_retract(manifest_json: string, protected_object_ids: string[]): string;

/**
 * Retract a single attachment, leaving the post and its other files in place.
 */
export function manifest_remove_attachment(manifest_json: string, item_id: string, attachment_url: string, protected_object_ids: string[], now: string): string;

/**
 * Open (create) the in-memory doc engine, with the namespace + author derived from
 * the Sia AppKey. Returns the namespace id. A second call rebuilds from scratch.
 */
export function open(app_key_hex: string): Promise<string>;

/**
 * Author side: open (or reopen) the write replica of a channel's doc from its
 * 32-byte namespace seed. Returns the namespace id. Idempotent — opening the same
 * channel twice reuses the replica rather than rebuilding it.
 *
 * The seed is derived by the app (from the AppKey + channelID) and handed in as
 * hex, rather than derived here from an `info` in `pin-derive`: since one
 * implementation computes it for both engines, there are no two copies to drift.
 */
export function open_channel_doc(ns_seed_hex: string): Promise<string>;

/**
 * The collection holding what this identity keeps — one record per pin.
 */
export function pinned_collection(): string;

/**
 * The rkey for one pin, from the logical item it keeps. The Curator's repack reads
 * these to learn what's in this identity's scope, so the spelling is shared.
 */
export function pinned_rkey(channel_id: string, published_at: string): string;

/**
 * The z-base32 public key for a 32-byte seed — the key a resolver looks up.
 */
export function pkarr_public_key(seed: Uint8Array): string;

/**
 * Publish TXT records signed by the key derived from `seed`, replacing whatever that
 * key previously pointed at. Takes seconds (DHT store latency); call in the background.
 */
export function pkarr_publish(seed: Uint8Array, records_json: string): Promise<void>;

/**
 * Resolve a `did:dht:<key>` (or bare key) to its current TXT records, as JSON. An
 * empty array means nothing is published or resolvable — an ordinary outcome, not an
 * error.
 */
export function pkarr_resolve(key: string): Promise<string>;

/**
 * The rkey for one channel's publish state — the spelling the keep-alive loop looks
 * under, so the frontend has to write it the same way.
 */
export function published_channel_rkey(channel_id: string): string;

/**
 * The collection holding publish state.
 */
export function published_collection(): string;

/**
 * The rkey for the settings snapshot's publish state. Same contract as above: the
 * frontend writes it when it snapshots, the keep-alive loop reads it to know which
 * pointer to republish.
 */
export function published_settings_rkey(): string;

/**
 * Write a record into a channel doc (author side only — a read replica rejects it
 * with "Attempted to insert to read only replica").
 */
export function put_channel_record(ns_id: string, collection: string, rkey: string, value: Uint8Array): Promise<void>;

/**
 * Write a record. `value` is opaque bytes (the app's encrypted blob).
 */
export function put_record(collection: string, rkey: string, value: Uint8Array): Promise<void>;

/**
 * The settings pad size, exposed so the app has one definition of it rather than a
 * copy that could drift out of step with what the padding actually does.
 */
export function settings_pad_size(): number;

/**
 * The TXT prefix the settings locator's pointer is chunked under. Read from here
 * rather than spelled again in TypeScript, because the frontend publishes this record
 * and the Curator republishes it — and a mismatch writes the pointer somewhere no
 * reader looks, which recovery cannot tell apart from having no settings at all.
 */
export function settings_pointer_prefix(): string;

/**
 * Produce a shareable DocTicket for this identity's doc (write capability + this
 * node's relay address). A peer imports it to sync. Lets a second browser tab act
 * as a sync counterpart during dev.
 */
export function share(): Promise<string>;

/**
 * Author side: mint a READ-mode ticket for a channel doc — the capability a
 * subscriber imports. Read-mode, so holding it can never write to the doc.
 * Call this while online; the ticket freezes the addresses known at this moment.
 */
export function share_channel_doc(ns_id: string): Promise<string>;

export function sia_account_snapshot(): Promise<string>;

export function sia_app_key_hex(): Promise<string | undefined>;

/**
 * Restore a session from a stored AppKey. `false` means the indexer does not
 * recognise it — approval revoked, or never registered — which sends the user back
 * to the welcome screen rather than being an error worth reporting.
 */
export function sia_connect(app_key_hex: string, indexer_url: string): Promise<boolean>;

export function sia_delete_object(id: string): Promise<void>;

export function sia_download_item(url: string): Promise<Uint8Array>;

export function sia_generate_recovery_phrase(): string;

/**
 * One object's slabs by id, as JSON. `None` when it is not in scope — a normal
 * answer (repack asks about references that may already be gone), not an error.
 */
export function sia_get_object_slabs(id: string): Promise<string | undefined>;

export function sia_is_connected(): Promise<boolean>;

export function sia_list_pinned_objects(): Promise<string>;

export function sia_pin_from_share_url(url: string): Promise<string>;

export function sia_prune_slabs(): Promise<void>;

/**
 * The public key for an AppKey, as `ed25519:<hex>`.
 *
 * Pure, so the client can capture it at construction — the accessor that reads it
 * is synchronous, and the value is stamped into every published channel manifest.
 */
export function sia_public_key(app_key_hex: string): string;

/**
 * Finish registration with the recovery phrase; returns the AppKey hex to persist.
 */
export function sia_register(mnemonic: string): Promise<string>;

/**
 * Begin a connection and return the URL the user approves at.
 */
export function sia_request_connection(indexer_url: string): Promise<string>;

export function sia_resolve_object_id(url: string): Promise<string>;

export function sia_upload_item(bytes: Uint8Array, on_shard?: Function | null): Promise<string>;

/**
 * Bin-pack several objects into shared slabs, preserving input order.
 *
 * Takes a JS array of `Uint8Array` rather than a framed blob: framing exists on the
 * desktop only because a raw IPC body is a single blob, which is not a constraint
 * here.
 */
export function sia_upload_items_packed(items: Array<any>, on_shard?: Function | null): Promise<string>;

/**
 * `Ok` for a well-formed phrase; the error carries why, for inline validation.
 */
export function sia_validate_recovery_phrase(phrase: string): void;

/**
 * Block until the user approves at the indexer.
 *
 * One long call that polls internally until approval or expiry, rather than
 * something to re-drive from a timer. Safe to invoke twice (React strict mode mounts
 * effects twice); the second call sees an already-approved request and returns.
 */
export function sia_wait_for_approval(): Promise<void>;

export function start(): void;

/**
 * Start the channel-doc serve loop in this tab.
 *
 * Serves each owned channel as a live replica and keeps a read ticket published, so a
 * subscriber is pushed new posts rather than polling for them. It copies the sealed
 * manifest out of the main doc verbatim, so it needs no Sia session and never sees a
 * channel's content.
 */
export function start_channel_doc_loop(app_key_hex: string, cadence_secs: number, on_pass: Function): Promise<void>;

/**
 * Start the channel live-sync loop in this tab.
 *
 * Imports each subscribed channel's doc from its author and writes what arrives into
 * `sub/<channelID>` — the same record the polling rung writes, so whatever renders is
 * already watching it.
 */
export function start_channel_sync_loop(app_key_hex: string, cadence_secs: number, retry_secs: number, on_pass: Function): Promise<void>;

/**
 * Start the identity-publishing loop in this tab — one packet under the did:dht key
 * carrying the directory pointer, the doc namespace, and every live endpoint.
 *
 * A tab publishes the same record a desktop does, from the same crate, because both
 * assemble it from the doc rather than from what they happen to know locally. That's
 * what stopped them overwriting each other.
 */
export function start_identity_loop(app_key_hex: string, namespace_id: string, cadence_secs: number, on_pass: Function): Promise<void>;

/**
 * Start this instance's registration loop in this tab.
 *
 * A tab is a real endpoint of this identity — it can be synced with and dialed over
 * its relay — so it belongs in the published set while it's open. It registers as NOT
 * durable, which is the honest difference: a desktop stays up, a tab doesn't, and a
 * peer choosing among endpoints should know which is which.
 */
export function start_instance_loop(cadence_secs: number, on_pass: Function): Promise<void>;

/**
 * Start the Curator's locator keep-alive loop in this tab.
 *
 * The same loop the desktop runs, and it matters here for the same reason: an owned
 * channel whose locator ages off the DHT stops resolving for its subscribers, and a
 * tab is a full instance of the Curator rather than a lesser one. Uptime is what
 * differs — a tab republishes while it's open, a desktop while it's on.
 *
 * Needs no Sia session: republishing re-signs a pointer that already names its object.
 */
export function start_keep_alive_loop(app_key_hex: string, cadence_secs: number, on_pass: Function): Promise<void>;

/**
 * Start the Curator's subscription pull loop in this tab.
 *
 * The same loop the desktop Curator runs, from the same crate — a tab is a shorter-
 * lived instance of the Curator, not a lesser one. What differs is uptime: this stops
 * when the tab closes, and a desktop's doesn't.
 *
 * Reports each pass to `on_pass` as a JSON `PullOutcome` (or an error string), which
 * is diagnostics only — the loop's actual output is the records it writes, and those
 * announce themselves on the change feed.
 *
 * Spawned locally rather than by the shared crate, because which executor a task
 * belongs on is a per-target question: here there is only one.
 */
export function start_pull_loop(app_key_hex: string, cadence_secs: number, on_pass: Function): Promise<void>;

/**
 * Start the instance rendezvous loop in this tab — advertise where this tab can be
 * reached, and sync with the identity's other instances.
 *
 * A tab is a full peer here, not a client: it publishes its own ticket and can be
 * synced FROM as well as syncing TO. It advertises as not-durable, which is the honest
 * difference — a peer choosing among endpoints should know which one will still be
 * there in an hour.
 */
export function start_rendezvous_loop(app_key_hex: string, cadence_secs: number, retry_secs: number, on_pass: Function): Promise<void>;

/**
 * Start the repack loop in this tab.
 *
 * The same loop the desktop Curator runs — scheduling isn't a capability boundary, so
 * a tab that's open tidies its own storage rather than waiting for a machine that
 * might not exist. It needs a connected Sia session, since every leg of a pass is a
 * Sia call.
 *
 * `now_secs` and `now_iso` come from the caller: wasm has no system clock, and the
 * loop is the wrong place to learn about one.
 */
export function start_repack_loop(app_key_hex: string, cadence_secs: number, on_pass: Function): Promise<void>;

/**
 * Start the doc-to-Sia snapshot loop in this tab.
 *
 * The identity's durability floor: whatever is in the doc, mirrored to Sia and named
 * by a published locator. One writer, reading the doc — it replaces a snapshot that
 * two React effects each took on their own debounce, racing on one pointer.
 */
export function start_snapshot_loop(app_key_hex: string, cadence_secs: number, settle_secs: number, on_pass: Function): Promise<void>;

/**
 * Join the peer(s) in `ticket` and live-sync this identity's doc with them.
 * `on_event` is invoked with a short label string per `LiveEvent` (insert-local /
 * insert-remote / sync-finished / neighbor-up|down) so the UI can show the loop is
 * alive. Subscribes BEFORE starting sync (mirroring iroh-docs' import_and_subscribe)
 * so no events are missed; the event pump runs on the local executor for the life
 * of the engine.
 *
 * NOTE (2026-07-25): the peer coordinates MUST include an address — the ticket
 * carries node id + relay URL + direct addrs. Dialing by a bare node id (letting
 * iroh discovery resolve it) does NOT work in the relay-only wasm/browser build
 * (no DNS resolver in the sandbox), so a rendezvous must publish the ticket/addr,
 * not just the id.
 */
export function start_sync(ticket: string, on_event: Function): Promise<void>;

/**
 * This instance's iroh network status, classified EXACTLY as the native Curator
 * does (see src-tauri/src/curator.rs) so the Curate page can render one interface
 * over both — a browser tab is a full peer, not a lesser tier, and its status
 * should read the same way.
 *
 * The honest browser differences show up as values, not missing fields:
 * `directAddrs` is normally empty because a tab has no listening socket, so every
 * path runs through a relay. `online` (a relay is connected) is therefore what
 * makes this tab dialable — by a peer that already holds its ADDRESS, since
 * discovery-by-bare-id doesn't resolve in wasm (see the note on `start_sync`).
 * `rpcServing` / `heyQueued` are real here too: the Router accepts the same
 * pin-keeper/0 ALPN the native Curator does.
 */
export function status(): any;

/**
 * Report every change to this instance's own doc, as `(collection, rkey, kind)`.
 *
 * This is the repo's CHANGE FEED — the "state out" half of repo-as-only-contract.
 * The frontend never has to ask whether a record moved: whatever wrote it (a peer's
 * device syncing in, or this instance's own Curator work) announces it, and one
 * listener routes by collection to decide what to re-read. It replaces per-feature
 * polling, which is what the app did before: each consumer that cared about a
 * background write ran its own timer, and every new Curator job would have added
 * another.
 *
 * Faithful, not filtered — the engine reports what happened and the frontend decides
 * what it means:
 *   - Record events (`insert-local` / `insert-remote`) carry `collection` + `rkey`,
 *     split by `pin_derive::parse_record_key` so both engines decompose keys the
 *     same way.
 *   - Stream-level events (`content-ready`, `sync-finished`, neighbor up/down) aren't
 *     about one record and carry EMPTY strings for both. `content-ready` in
 *     particular still matters: iroh-blobs content LAGS the entry, so a reader that
 *     acted only on `insert-remote` can find the value not yet readable. An empty
 *     collection means "something landed — re-check what you care about."
 *   - Local writes are reported too, so a consumer can see its own write land.
 *     Filtering them out is the caller's job (`isRemoteChange` in docs.ts).
 *
 * One pump per engine; a second call is a no-op. Only `open()` (which rebuilds the
 * engine) clears that.
 */
export function subscribe_doc_changes(on_change: Function): Promise<void>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly channel_doc_namespaces: () => [number, number, number];
    readonly channel_id: (a: number, b: number) => [number, number, number, number];
    readonly channel_open_blob: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly channel_publish: (a: number, b: number, c: number, d: number) => any;
    readonly channel_republish_pointer: (a: number, b: number, c: number, d: number) => any;
    readonly channel_resolve: (a: number, b: number) => any;
    readonly content_hash: (a: number, b: number) => [number, number];
    readonly decrypt_for_channel: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly decrypt_settings: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly delete_channel_record: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
    readonly delete_record: (a: number, b: number, c: number, d: number) => any;
    readonly derive_channel_doc_seed: (a: number, b: number, c: number, d: number) => [number, number];
    readonly derive_channel_doc_ticket_seed: (a: number, b: number) => [number, number];
    readonly derive_channel_locator_seed: (a: number, b: number) => [number, number];
    readonly derive_did_dht_seed: (a: number, b: number) => [number, number];
    readonly derive_pinned_key: (a: number, b: number) => [number, number];
    readonly derive_published_key: (a: number, b: number) => [number, number];
    readonly derive_rendezvous_instance_seed: (a: number, b: number, c: number, d: number) => [number, number];
    readonly derive_rendezvous_seed: (a: number, b: number) => [number, number];
    readonly derive_settings_key: (a: number, b: number) => [number, number];
    readonly derive_settings_locator_seed: (a: number, b: number) => [number, number];
    readonly derive_snapshot_key: (a: number, b: number) => [number, number];
    readonly encrypt_for_channel: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encrypt_settings: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly get_channel_record: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
    readonly get_record: (a: number, b: number, c: number, d: number) => any;
    readonly import_channel_doc: (a: number, b: number, c: any) => any;
    readonly list_all: () => any;
    readonly list_records: (a: number, b: number) => any;
    readonly manifest_append_item: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly manifest_build_item: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly manifest_create_channel: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly manifest_delete_item: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly manifest_edit_channel: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly manifest_edit_item: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly manifest_enumerate_retract: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly manifest_remove_attachment: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly open: (a: number, b: number) => any;
    readonly open_channel_doc: (a: number, b: number) => any;
    readonly pinned_collection: () => [number, number];
    readonly pinned_rkey: (a: number, b: number, c: number, d: number) => [number, number];
    readonly pkarr_public_key: (a: number, b: number) => [number, number, number, number];
    readonly pkarr_publish: (a: number, b: number, c: number, d: number) => any;
    readonly pkarr_resolve: (a: number, b: number) => any;
    readonly published_channel_rkey: (a: number, b: number) => [number, number];
    readonly published_collection: () => [number, number];
    readonly published_settings_rkey: () => [number, number];
    readonly put_channel_record: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
    readonly put_record: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
    readonly settings_pad_size: () => number;
    readonly settings_pointer_prefix: () => [number, number];
    readonly share: () => any;
    readonly share_channel_doc: (a: number, b: number) => any;
    readonly sia_account_snapshot: () => any;
    readonly sia_app_key_hex: () => any;
    readonly sia_connect: (a: number, b: number, c: number, d: number) => any;
    readonly sia_delete_object: (a: number, b: number) => any;
    readonly sia_download_item: (a: number, b: number) => any;
    readonly sia_generate_recovery_phrase: () => [number, number];
    readonly sia_get_object_slabs: (a: number, b: number) => any;
    readonly sia_is_connected: () => any;
    readonly sia_list_pinned_objects: () => any;
    readonly sia_pin_from_share_url: (a: number, b: number) => any;
    readonly sia_prune_slabs: () => any;
    readonly sia_public_key: (a: number, b: number) => [number, number, number, number];
    readonly sia_register: (a: number, b: number) => any;
    readonly sia_request_connection: (a: number, b: number) => any;
    readonly sia_resolve_object_id: (a: number, b: number) => any;
    readonly sia_upload_item: (a: number, b: number, c: number) => any;
    readonly sia_upload_items_packed: (a: any, b: number) => any;
    readonly sia_validate_recovery_phrase: (a: number, b: number) => [number, number];
    readonly sia_wait_for_approval: () => any;
    readonly start_channel_doc_loop: (a: number, b: number, c: number, d: any) => any;
    readonly start_channel_sync_loop: (a: number, b: number, c: number, d: number, e: any) => any;
    readonly start_identity_loop: (a: number, b: number, c: number, d: number, e: number, f: any) => any;
    readonly start_instance_loop: (a: number, b: any) => any;
    readonly start_keep_alive_loop: (a: number, b: number, c: number, d: any) => any;
    readonly start_pull_loop: (a: number, b: number, c: number, d: any) => any;
    readonly start_rendezvous_loop: (a: number, b: number, c: number, d: number, e: any) => any;
    readonly start_repack_loop: (a: number, b: number, c: number, d: any) => any;
    readonly start_snapshot_loop: (a: number, b: number, c: number, d: number, e: any) => any;
    readonly start_sync: (a: number, b: number, c: any) => any;
    readonly status: () => [number, number, number];
    readonly subscribe_doc_changes: (a: any) => any;
    readonly start: () => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__hc5f3e21d0efe8974: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7_5: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7_6: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h08f43aa7048968fb: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h9c38374c5ff5ba70: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__ha8ba71d4db3f24d7: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hd745e8189b95fcf4: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h43ae6dd74759854d: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h5a55095f3e22c2db: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h786b4ed5039223cd: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hfd95e48486b082ea: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__ha3a167bd92644a00: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
