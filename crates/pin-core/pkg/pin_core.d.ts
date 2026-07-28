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
 * Delete a record (tombstone).
 */
export function delete_record(collection: string, rkey: string): Promise<void>;

/**
 * Read a record's bytes, or `undefined` if absent.
 */
export function get_record(collection: string, rkey: string): Promise<Uint8Array | undefined>;

/**
 * List every record's full key (`collection/rkey`) across all collections.
 * Returns a JS array of strings. Used to snapshot the whole doc (docsMirror).
 */
export function list_all(): Promise<any>;

/**
 * List the rkeys under a collection (entries whose key starts with `collection/`).
 * Returns a JS array of strings.
 */
export function list_records(collection: string): Promise<any>;

/**
 * Open (create) the in-memory doc engine, with the namespace + author derived from
 * the Sia AppKey. Returns the namespace id. A second call rebuilds from scratch.
 */
export function open(app_key_hex: string): Promise<string>;

/**
 * Write a record. `value` is opaque bytes (the app's encrypted blob).
 */
export function put_record(collection: string, rkey: string, value: Uint8Array): Promise<void>;

/**
 * Produce a shareable DocTicket for this identity's doc (write capability + this
 * node's relay address). A peer imports it to sync. Lets a second browser tab act
 * as a sync counterpart during dev.
 */
export function share(): Promise<string>;

export function start(): void;

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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly delete_record: (a: number, b: number, c: number, d: number) => any;
    readonly get_record: (a: number, b: number, c: number, d: number) => any;
    readonly list_all: () => any;
    readonly list_records: (a: number, b: number) => any;
    readonly open: (a: number, b: number) => any;
    readonly put_record: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
    readonly share: () => any;
    readonly start_sync: (a: number, b: number, c: any) => any;
    readonly status: () => [number, number, number];
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
    readonly wasm_bindgen__convert__closures_____invoke__hc5f3e21d0efe8974: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h08f43aa7048968fb: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h88edf5d76da6fe27: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hab35a47f448791db: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h106cbabba281c03b: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h9ac60b4f9395e24b: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h8daa9f8fce1ac3eb: (a: number, b: number) => void;
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
