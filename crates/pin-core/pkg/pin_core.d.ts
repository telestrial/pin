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

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly delete_record: (a: number, b: number, c: number, d: number) => any;
    readonly get_record: (a: number, b: number, c: number, d: number) => any;
    readonly list_records: (a: number, b: number) => any;
    readonly open: (a: number, b: number) => any;
    readonly put_record: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
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
    readonly wasm_bindgen__convert__closures_____invoke__hd5db4addbd66c50a: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h32ca3517c0856aa3: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3083644178357d32: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h19a1235879b3830c: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h22cf045be9df4569: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1897a61d1a5b3e1d: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h064b383873395853: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__ha18f15979365619b: (a: number, b: number) => void;
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
