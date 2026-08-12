/* @ts-self-types="./pin_core.d.ts" */

export class IntoUnderlyingByteSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingByteSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get autoAllocateChunkSize() {
        const ret = wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingbytesource_cancel(ptr);
    }
    /**
     * @param {ReadableByteStreamController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingbytesource_pull(this.__wbg_ptr, controller);
        return ret;
    }
    /**
     * @param {ReadableByteStreamController} controller
     */
    start(controller) {
        wasm.intounderlyingbytesource_start(this.__wbg_ptr, controller);
    }
    /**
     * @returns {ReadableStreamType}
     */
    get type() {
        const ret = wasm.intounderlyingbytesource_type(this.__wbg_ptr);
        return __wbindgen_enum_ReadableStreamType[ret];
    }
}
if (Symbol.dispose) IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free;

export class IntoUnderlyingSink {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSinkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsink_free(ptr, 0);
    }
    /**
     * @param {any} reason
     * @returns {Promise<any>}
     */
    abort(reason) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_abort(ptr, reason);
        return ret;
    }
    /**
     * @returns {Promise<any>}
     */
    close() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.intounderlyingsink_close(ptr);
        return ret;
    }
    /**
     * @param {any} chunk
     * @returns {Promise<any>}
     */
    write(chunk) {
        const ret = wasm.intounderlyingsink_write(this.__wbg_ptr, chunk);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free;

export class IntoUnderlyingSource {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntoUnderlyingSourceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_intounderlyingsource_free(ptr, 0);
    }
    cancel() {
        const ptr = this.__destroy_into_raw();
        wasm.intounderlyingsource_cancel(ptr);
    }
    /**
     * @param {ReadableStreamDefaultController} controller
     * @returns {Promise<any>}
     */
    pull(controller) {
        const ret = wasm.intounderlyingsource_pull(this.__wbg_ptr, controller);
        return ret;
    }
}
if (Symbol.dispose) IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free;

/**
 * The namespace ids of every channel doc currently open. Lets the app avoid
 * re-importing one it already holds, and gives the Curate page something to show.
 * @returns {any}
 */
export function channel_doc_namespaces() {
    const ret = wasm.channel_doc_namespaces();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * A channel's public identifier, derived from its key. Pin's own format (a truncated
 * SHA-256 in a specific base32 alphabet), so it is derived in one place rather than
 * independently on each side — two sides disagreeing would name the same channel
 * differently and never find each other's.
 * @param {Uint8Array} channel_key
 * @returns {string}
 */
export function channel_id(channel_key) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(channel_key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.channel_id(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Open a sealed manifest blob with K — the path a CACHED copy takes, so that a cached
 * read and a fresh resolve decode identically.
 * @param {Uint8Array} channel_key
 * @param {string} blob
 * @returns {string}
 */
export function channel_open_blob(channel_key, blob) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(channel_key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(blob, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.channel_open_blob(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Seal a manifest under K, upload it, and publish the pointer. Returns `Published`
 * as JSON — the caller needs the object id to reclaim the generation it superseded.
 * @param {Uint8Array} channel_key
 * @param {string} manifest_json
 * @returns {Promise<string>}
 */
export function channel_publish(channel_key, manifest_json) {
    const ptr0 = passArray8ToWasm0(channel_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(manifest_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.channel_publish(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Re-sign a channel's current pointer to refresh its TTL, without minting a new object.
 * @param {Uint8Array} channel_key
 * @param {string} item_url
 * @returns {Promise<void>}
 */
export function channel_republish_pointer(channel_key, item_url) {
    const ptr0 = passArray8ToWasm0(channel_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(item_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.channel_republish_pointer(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Read a channel from K alone. `undefined` when the locator resolves to nothing, which
 * is ordinary — unpublished, or aged off the DHT.
 * @param {Uint8Array} channel_key
 * @returns {Promise<string | undefined>}
 */
export function channel_resolve(channel_key) {
    const ptr0 = passArray8ToWasm0(channel_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.channel_resolve(ptr0, len0);
    return ret;
}

/**
 * A plaintext content fingerprint (CIDv1, raw codec, SHA-256).
 *
 * Uploads already carry their own hash back from `pin-sia`, so nothing in the
 * production path calls this — it exists for bytes the app holds without having just
 * uploaded them, which today means the integration tier's fake client.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function content_hash(bytes) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.content_hash(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Open a base64 blob sealed under a channel key. The plaintext is UTF-8 (a manifest's
 * JSON), so this returns it as a string.
 * @param {Uint8Array} key
 * @param {string} blob_b64
 * @returns {string}
 */
export function decrypt_for_channel(key, blob_b64) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(blob_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.decrypt_for_channel(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Open a padded settings blob, returning the payload with the padding stripped.
 * @param {Uint8Array} key
 * @param {string} blob_b64
 * @returns {string}
 */
export function decrypt_settings(key, blob_b64) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(blob_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.decrypt_settings(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Delete a record from a channel doc (author side).
 * @param {string} ns_id
 * @param {string} collection
 * @param {string} rkey
 * @returns {Promise<void>}
 */
export function delete_channel_record(ns_id, collection, rkey) {
    const ptr0 = passStringToWasm0(ns_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(collection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(rkey, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.delete_channel_record(ptr0, len0, ptr1, len1, ptr2, len2);
    return ret;
}

/**
 * Delete a record (tombstone).
 * @param {string} collection
 * @param {string} rkey
 * @returns {Promise<void>}
 */
export function delete_record(collection, rkey) {
    const ptr0 = passStringToWasm0(collection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(rkey, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.delete_record(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * A channel's iroh-docs namespace seed (AppKey-derived — the write capability stays
 * with the author).
 * @param {Uint8Array} app_key
 * @param {string} channel_id
 * @returns {Uint8Array}
 */
export function derive_channel_doc_seed(app_key, channel_id) {
    const ptr0 = passArray8ToWasm0(app_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(channel_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.derive_channel_doc_seed(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * The pkarr seed for a channel's read-DocTicket record, from its channel key K.
 * @param {Uint8Array} channel_key
 * @returns {Uint8Array}
 */
export function derive_channel_doc_ticket_seed(channel_key) {
    const ptr0 = passArray8ToWasm0(channel_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.derive_channel_doc_ticket_seed(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * A channel's pkarr locator seed, from its channel key K.
 * @param {Uint8Array} channel_key
 * @returns {Uint8Array}
 */
export function derive_channel_locator_seed(channel_key) {
    const ptr0 = passArray8ToWasm0(channel_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.derive_channel_locator_seed(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The identity's did:dht ed25519 seed — the same value `identity.rs` derives.
 * @param {Uint8Array} app_key
 * @returns {Uint8Array}
 */
export function derive_did_dht_seed(app_key) {
    const ptr0 = passArray8ToWasm0(app_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.derive_did_dht_seed(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Pin-record encryption key.
 * @param {Uint8Array} app_key
 * @returns {Uint8Array}
 */
export function derive_pinned_key(app_key) {
    const ptr0 = passArray8ToWasm0(app_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.derive_pinned_key(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Publish-state encryption key.
 * @param {Uint8Array} app_key
 * @returns {Uint8Array}
 */
export function derive_published_key(app_key) {
    const ptr0 = passArray8ToWasm0(app_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.derive_published_key(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The pkarr seed for one instance's rendezvous entry.
 * @param {Uint8Array} rendezvous_seed
 * @param {string} instance_id
 * @returns {Uint8Array}
 */
export function derive_rendezvous_instance_seed(rendezvous_seed, instance_id) {
    const ptr0 = passArray8ToWasm0(rendezvous_seed, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(instance_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.derive_rendezvous_instance_seed(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * The pkarr seed for your instance-rendezvous directory.
 * @param {Uint8Array} app_key
 * @returns {Uint8Array}
 */
export function derive_rendezvous_seed(app_key) {
    const ptr0 = passArray8ToWasm0(app_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.derive_rendezvous_seed(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Settings-record encryption key.
 * @param {Uint8Array} app_key
 * @returns {Uint8Array}
 */
export function derive_settings_key(app_key) {
    const ptr0 = passArray8ToWasm0(app_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.derive_settings_key(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The pkarr seed for your settings-snapshot pointer.
 * @param {Uint8Array} app_key
 * @returns {Uint8Array}
 */
export function derive_settings_locator_seed(app_key) {
    const ptr0 = passArray8ToWasm0(app_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.derive_settings_locator_seed(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Sia whole-doc snapshot encryption key.
 * @param {Uint8Array} app_key
 * @returns {Uint8Array}
 */
export function derive_snapshot_key(app_key) {
    const ptr0 = passArray8ToWasm0(app_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.derive_snapshot_key(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Seal a UTF-8 string under a channel key, returning the base64 blob.
 * @param {Uint8Array} key
 * @param {string} plaintext
 * @returns {string}
 */
export function encrypt_for_channel(key, plaintext) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(plaintext, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.encrypt_for_channel(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Seal the settings payload, padded to a fixed size so its length carries nothing.
 * @param {Uint8Array} key
 * @param {string} plaintext
 * @returns {string}
 */
export function encrypt_settings(key, plaintext) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(plaintext, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.encrypt_settings(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * The collection this identity's own endorsements live in.
 * @returns {string}
 */
export function endorse_collection() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.endorse_collection();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Where one endorsement lives. Needed on its own as well as from `sign_endorsement`,
 * because withdrawing one addresses the record without producing another.
 * @param {string} kind
 * @param {string} channel_id
 * @param {string} published_at
 * @param {string | null} [attachment]
 * @returns {string}
 */
export function endorse_rkey(kind, channel_id, published_at, attachment) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(channel_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(published_at, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        var ptr3 = isLikeNone(attachment) ? 0 : passStringToWasm0(attachment, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len3 = WASM_VECTOR_LEN;
        const ret = wasm.endorse_rkey(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        deferred5_0 = ret[0];
        deferred5_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Whether an endorsement holds up: signed by the identity it claims, and consistent
 * with any coordinates it carries.
 *
 * Exposed so nothing verifies a record twice. Anything that displays a count from
 * records it did not write is asserting they are real, and a second implementation of
 * that check is a second chance to accept a forgery.
 * @param {string} record_json
 */
export function endorsement_verify(record_json) {
    const ptr0 = passStringToWasm0(record_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.endorsement_verify(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * The subject an endorsement of this item names — the hash a count is keyed by, so a
 * reader can find the aggregate for something it is displaying.
 *
 * `attachment` names one of the post's attachments by its content hash, in which case
 * the subject is that FILE's rather than the post's. Its count is separate on purpose:
 * keeping an attachment alive is not keeping the post alive, and counting a partial
 * custodian as a full one would overstate the redundancy the number reports.
 * @param {string} channel_id
 * @param {string} published_at
 * @param {string | null} [attachment]
 * @returns {string}
 */
export function engagement_subject(channel_id, published_at, attachment) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(channel_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(published_at, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(attachment) ? 0 : passStringToWasm0(attachment, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len2 = WASM_VECTOR_LEN;
        const ret = wasm.engagement_subject(ptr0, len0, ptr1, len1, ptr2, len2);
        deferred4_0 = ret[0];
        deferred4_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Read a record from a channel doc, or `undefined` if absent.
 *
 * Author-AGNOSTIC (`single_latest_per_key`, no author filter) — deliberately. On the
 * subscriber side the entry was written by the channel owner, whose `AuthorId` we
 * don't hold and would otherwise have to publish. Safe because the capability is
 * read-only for everyone but the owner: any entry at this key IS theirs. This is the
 * simplification the read-ticket choice buys.
 * @param {string} ns_id
 * @param {string} collection
 * @param {string} rkey
 * @returns {Promise<Uint8Array | undefined>}
 */
export function get_channel_record(ns_id, collection, rkey) {
    const ptr0 = passStringToWasm0(ns_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(collection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(rkey, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.get_channel_record(ptr0, len0, ptr1, len1, ptr2, len2);
    return ret;
}

/**
 * Read a record's bytes, or `undefined` if absent.
 * @param {string} collection
 * @param {string} rkey
 * @returns {Promise<Uint8Array | undefined>}
 */
export function get_record(collection, rkey) {
    const ptr0 = passStringToWasm0(collection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(rkey, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.get_record(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Subscriber side: import a channel's read ticket and live-sync it. Returns the
 * namespace id. `on_event(nsID, kind, key)` fires per `LiveEvent` — structured
 * rather than one string so the frontend never parses a label, and the desktop's
 * Tauri-event payload carries the same three fields.
 *
 * Uses `import_and_subscribe`, which subscribes BEFORE starting sync — so the first
 * reconciliation's events can't be missed (the initial catch-up is exactly the one
 * we most want to see).
 * @param {string} ticket
 * @param {Function} on_event
 * @returns {Promise<string>}
 */
export function import_channel_doc(ticket, on_event) {
    const ptr0 = passStringToWasm0(ticket, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.import_channel_doc(ptr0, len0, on_event);
    return ret;
}

/**
 * Every record in the doc, as `{collection, rkey}` pairs (JSON). Used to snapshot the
 * whole doc (docsMirror).
 *
 * The key is split HERE, by `pin_derive`'s `RecordKey`, rather than handed over raw
 * for the frontend to split — so this engine and the desktop's decompose keys with
 * one definition. Keys that aren't record keys are skipped: a whole-doc snapshot
 * shouldn't fail over one stray key.
 * @returns {Promise<string>}
 */
export function list_all() {
    const ret = wasm.list_all();
    return ret;
}

/**
 * List the rkeys under a collection (entries whose key starts with `collection/`).
 * Returns a JS array of strings.
 * @param {string} collection
 * @returns {Promise<any>}
 */
export function list_records(collection) {
    const ptr0 = passStringToWasm0(collection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.list_records(ptr0, len0);
    return ret;
}

/**
 * Add a newly published item to the front of the channel.
 * @param {string} manifest_json
 * @param {string} item_json
 * @param {string} now
 * @returns {string}
 */
export function manifest_append_item(manifest_json, item_json, now) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(manifest_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(item_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(now, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.manifest_append_item(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Shape an upload result and a draft into the item that goes in the manifest.
 * @param {string} uploaded_json
 * @param {string} draft_json
 * @param {string} now
 * @returns {string}
 */
export function manifest_build_item(uploaded_json, draft_json, now) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(uploaded_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(draft_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(now, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.manifest_build_item(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Build the manifest a new channel starts life as.
 *
 * Images arrive already stored, as references inside the args — storing bytes needs a
 * connected Sia session, and which one that is differs by platform, so it stays with the
 * caller and this stays a pure build.
 * @param {string} new_channel_json
 * @param {string} now
 * @returns {string}
 */
export function manifest_create_channel(new_channel_json, now) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(new_channel_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(now, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.manifest_create_channel(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Retract one item, returning the next manifest and the bytes nothing else references.
 * @param {string} manifest_json
 * @param {string} item_id
 * @param {string[]} protected_object_ids
 * @param {string} now
 * @returns {string}
 */
export function manifest_delete_item(manifest_json, item_id, protected_object_ids, now) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(manifest_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(item_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayJsValueToWasm0(protected_object_ids, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(now, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.manifest_delete_item(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Apply a patch to a channel's details, reporting the images it left behind.
 * @param {string} manifest_json
 * @param {string} patch_json
 * @param {string} now
 * @returns {string}
 */
export function manifest_edit_channel(manifest_json, patch_json, now) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(manifest_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(patch_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(now, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.manifest_edit_channel(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Replace an item's content, keeping its place in the channel's chronology.
 * @param {string} manifest_json
 * @param {string} old_item_id
 * @param {string} new_item_json
 * @param {string[]} removed_attachment_object_ids
 * @param {string} now
 * @returns {string}
 */
export function manifest_edit_item(manifest_json, old_item_id, new_item_json, removed_attachment_object_ids, now) {
    let deferred7_0;
    let deferred7_1;
    try {
        const ptr0 = passStringToWasm0(manifest_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(old_item_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(new_item_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayJsValueToWasm0(removed_attachment_object_ids, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(now, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.manifest_edit_item(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
        var ptr6 = ret[0];
        var len6 = ret[1];
        if (ret[3]) {
            ptr6 = 0; len6 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred7_0 = ptr6;
        deferred7_1 = len6;
        return getStringFromWasm0(ptr6, len6);
    } finally {
        wasm.__wbindgen_free(deferred7_0, deferred7_1, 1);
    }
}

/**
 * Enumerate what a whole-channel retract leaves behind. `manifest_json` is empty when
 * the locator no longer resolves — a retract whose target is already gone still
 * succeeds, having nothing to enumerate.
 * @param {string} manifest_json
 * @param {string[]} protected_object_ids
 * @returns {string}
 */
export function manifest_enumerate_retract(manifest_json, protected_object_ids) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(manifest_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayJsValueToWasm0(protected_object_ids, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.manifest_enumerate_retract(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Retract a single attachment, leaving the post and its other files in place.
 * @param {string} manifest_json
 * @param {string} item_id
 * @param {string} attachment_url
 * @param {string[]} protected_object_ids
 * @param {string} now
 * @returns {string}
 */
export function manifest_remove_attachment(manifest_json, item_id, attachment_url, protected_object_ids, now) {
    let deferred7_0;
    let deferred7_1;
    try {
        const ptr0 = passStringToWasm0(manifest_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(item_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(attachment_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayJsValueToWasm0(protected_object_ids, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(now, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.manifest_remove_attachment(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
        var ptr6 = ret[0];
        var len6 = ret[1];
        if (ret[3]) {
            ptr6 = 0; len6 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred7_0 = ptr6;
        deferred7_1 = len6;
        return getStringFromWasm0(ptr6, len6);
    } finally {
        wasm.__wbindgen_free(deferred7_0, deferred7_1, 1);
    }
}

/**
 * Open (create) the in-memory doc engine, with the namespace + author derived from
 * the Sia AppKey. Returns the namespace id. A second call rebuilds from scratch.
 * @param {string} app_key_hex
 * @returns {Promise<string>}
 */
export function open(app_key_hex) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.open(ptr0, len0);
    return ret;
}

/**
 * Author side: open (or reopen) the write replica of a channel's doc from its
 * 32-byte namespace seed. Returns the namespace id. Idempotent — opening the same
 * channel twice reuses the replica rather than rebuilding it.
 *
 * The seed is derived by the app (from the AppKey + channelID) and handed in as
 * hex, rather than derived here from an `info` in `pin-derive`: since one
 * implementation computes it for both engines, there are no two copies to drift.
 * @param {string} ns_seed_hex
 * @returns {Promise<string>}
 */
export function open_channel_doc(ns_seed_hex) {
    const ptr0 = passStringToWasm0(ns_seed_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.open_channel_doc(ptr0, len0);
    return ret;
}

/**
 * The collection holding what this identity keeps — one record per pin.
 * @returns {string}
 */
export function pinned_collection() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.pinned_collection();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * The rkey for one pin, from the logical item it keeps. The Curator's repack reads
 * these to learn what's in this identity's scope, so the spelling is shared.
 * @param {string} channel_id
 * @param {string} published_at
 * @returns {string}
 */
export function pinned_rkey(channel_id, published_at) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(channel_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(published_at, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.pinned_rkey(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Split a value into indexed TXT records under a prefix.
 * @param {string} prefix
 * @param {string} value
 * @returns {string}
 */
export function pkarr_chunk_txt(prefix, value) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.pkarr_chunk_txt(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * The z-base32 public key for a 32-byte seed — the key a resolver looks up.
 * @param {Uint8Array} seed
 * @returns {string}
 */
export function pkarr_public_key(seed) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pkarr_public_key(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Publish TXT records signed by the key derived from `seed`, replacing whatever that
 * key previously pointed at. Takes seconds (DHT store latency); call in the background.
 * @param {Uint8Array} seed
 * @param {string} records_json
 * @returns {Promise<void>}
 */
export function pkarr_publish(seed, records_json) {
    const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(records_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.pkarr_publish(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Rejoin a value split under a prefix. Records arrive in any order and with
 * fully-qualified names (`_c0.<pubkey>`), which is how a resolve returns them. Anything
 * not matching the prefix is ignored, so an empty string means "nothing published here".
 * @param {string} records_json
 * @param {string} prefix
 * @returns {string}
 */
export function pkarr_rejoin_txt(records_json, prefix) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(records_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.pkarr_rejoin_txt(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Resolve a `did:dht:<key>` (or bare key) to its current TXT records, as JSON. An
 * empty array means nothing is published or resolvable — an ordinary outcome, not an
 * error.
 * @param {string} key
 * @returns {Promise<string>}
 */
export function pkarr_resolve(key) {
    const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.pkarr_resolve(ptr0, len0);
    return ret;
}

/**
 * The rkey for one channel's publish state — the spelling the keep-alive loop looks
 * under, so the frontend has to write it the same way.
 * @param {string} channel_id
 * @returns {string}
 */
export function published_channel_rkey(channel_id) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(channel_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.published_channel_rkey(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * The collection holding publish state.
 * @returns {string}
 */
export function published_collection() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.published_collection();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * The rkey for the settings snapshot's publish state. Same contract as above: the
 * frontend writes it when it snapshots, the keep-alive loop reads it to know which
 * pointer to republish.
 * @returns {string}
 */
export function published_settings_rkey() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.published_settings_rkey();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Write a record into a channel doc (author side only — a read replica rejects it
 * with "Attempted to insert to read only replica").
 * @param {string} ns_id
 * @param {string} collection
 * @param {string} rkey
 * @param {Uint8Array} value
 * @returns {Promise<void>}
 */
export function put_channel_record(ns_id, collection, rkey, value) {
    const ptr0 = passStringToWasm0(ns_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(collection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(rkey, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(value, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.put_channel_record(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    return ret;
}

/**
 * Write a record. `value` is opaque bytes (the app's encrypted blob).
 * @param {string} collection
 * @param {string} rkey
 * @param {Uint8Array} value
 * @returns {Promise<void>}
 */
export function put_record(collection, rkey, value) {
    const ptr0 = passStringToWasm0(collection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(rkey, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(value, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.put_record(ptr0, len0, ptr1, len1, ptr2, len2);
    return ret;
}

/**
 * The settings pad size, exposed so the app has one definition of it rather than a
 * copy that could drift out of step with what the padding actually does.
 * @returns {number}
 */
export function settings_pad_size() {
    const ret = wasm.settings_pad_size();
    return ret >>> 0;
}

/**
 * The TXT prefix the settings locator's pointer is chunked under. Read from here
 * rather than spelled again in TypeScript, because the frontend publishes this record
 * and the Curator republishes it — and a mismatch writes the pointer somewhere no
 * reader looks, which recovery cannot tell apart from having no settings at all.
 * @returns {string}
 */
export function settings_pointer_prefix() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.settings_pointer_prefix();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Produce a shareable DocTicket for this identity's doc (write capability + this
 * node's relay address). A peer imports it to sync. Lets a second browser tab act
 * as a sync counterpart during dev.
 * @returns {Promise<string>}
 */
export function share() {
    const ret = wasm.share();
    return ret;
}

/**
 * Author side: mint a READ-mode ticket for a channel doc — the capability a
 * subscriber imports. Read-mode, so holding it can never write to the doc.
 * Call this while online; the ticket freezes the addresses known at this moment.
 * @param {string} ns_id
 * @returns {Promise<string>}
 */
export function share_channel_doc(ns_id) {
    const ptr0 = passStringToWasm0(ns_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.share_channel_doc(ptr0, len0);
    return ret;
}

/**
 * @returns {Promise<string>}
 */
export function sia_account_snapshot() {
    const ret = wasm.sia_account_snapshot();
    return ret;
}

/**
 * @returns {Promise<string | undefined>}
 */
export function sia_app_key_hex() {
    const ret = wasm.sia_app_key_hex();
    return ret;
}

/**
 * Restore a session from a stored AppKey. `false` means the indexer does not
 * recognise it — approval revoked, or never registered — which sends the user back
 * to the welcome screen rather than being an error worth reporting.
 * @param {string} app_key_hex
 * @param {string} indexer_url
 * @returns {Promise<boolean>}
 */
export function sia_connect(app_key_hex, indexer_url) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(indexer_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.sia_connect(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export function sia_delete_object(id) {
    const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sia_delete_object(ptr0, len0);
    return ret;
}

/**
 * @param {string} url
 * @returns {Promise<Uint8Array>}
 */
export function sia_download_item(url) {
    const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sia_download_item(ptr0, len0);
    return ret;
}

/**
 * @returns {string}
 */
export function sia_generate_recovery_phrase() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.sia_generate_recovery_phrase();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * One object's slabs by id, as JSON. `None` when it is not in scope — a normal
 * answer (repack asks about references that may already be gone), not an error.
 * @param {string} id
 * @returns {Promise<string | undefined>}
 */
export function sia_get_object_slabs(id) {
    const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sia_get_object_slabs(ptr0, len0);
    return ret;
}

/**
 * @returns {Promise<boolean>}
 */
export function sia_is_connected() {
    const ret = wasm.sia_is_connected();
    return ret;
}

/**
 * @returns {Promise<string>}
 */
export function sia_list_pinned_objects() {
    const ret = wasm.sia_list_pinned_objects();
    return ret;
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
export function sia_pin_from_share_url(url) {
    const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sia_pin_from_share_url(ptr0, len0);
    return ret;
}

/**
 * @returns {Promise<void>}
 */
export function sia_prune_slabs() {
    const ret = wasm.sia_prune_slabs();
    return ret;
}

/**
 * The public key for an AppKey, as `ed25519:<hex>`.
 *
 * Pure, so the client can capture it at construction — the accessor that reads it
 * is synchronous, and the value is stamped into every published channel manifest.
 * @param {string} app_key_hex
 * @returns {string}
 */
export function sia_public_key(app_key_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sia_public_key(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Finish registration with the recovery phrase; returns the AppKey hex to persist.
 * @param {string} mnemonic
 * @returns {Promise<string>}
 */
export function sia_register(mnemonic) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sia_register(ptr0, len0);
    return ret;
}

/**
 * Begin a connection and return the URL the user approves at.
 * @param {string} indexer_url
 * @returns {Promise<string>}
 */
export function sia_request_connection(indexer_url) {
    const ptr0 = passStringToWasm0(indexer_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sia_request_connection(ptr0, len0);
    return ret;
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
export function sia_resolve_object_id(url) {
    const ptr0 = passStringToWasm0(url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sia_resolve_object_id(ptr0, len0);
    return ret;
}

/**
 * @param {Uint8Array} bytes
 * @param {Function | null} [on_shard]
 * @returns {Promise<string>}
 */
export function sia_upload_item(bytes, on_shard) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sia_upload_item(ptr0, len0, isLikeNone(on_shard) ? 0 : addToExternrefTable0(on_shard));
    return ret;
}

/**
 * Bin-pack several objects into shared slabs, preserving input order.
 *
 * Takes a JS array of `Uint8Array` rather than a framed blob: framing exists on the
 * desktop only because a raw IPC body is a single blob, which is not a constraint
 * here.
 * @param {Array<any>} items
 * @param {Function | null} [on_shard]
 * @returns {Promise<string>}
 */
export function sia_upload_items_packed(items, on_shard) {
    const ret = wasm.sia_upload_items_packed(items, isLikeNone(on_shard) ? 0 : addToExternrefTable0(on_shard));
    return ret;
}

/**
 * `Ok` for a well-formed phrase; the error carries why, for inline validation.
 * @param {string} phrase
 */
export function sia_validate_recovery_phrase(phrase) {
    const ptr0 = passStringToWasm0(phrase, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sia_validate_recovery_phrase(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Block until the user approves at the indexer.
 *
 * One long call that polls internally until approval or expiry, rather than
 * something to re-drive from a timer. Safe to invoke twice (React strict mode mounts
 * effects twice); the second call sees an already-approved request and returns.
 * @returns {Promise<void>}
 */
export function sia_wait_for_approval() {
    const ret = wasm.sia_wait_for_approval();
    return ret;
}

/**
 * Sign one endorsement, returning the record as the exact JSON to store.
 *
 * Serialized here rather than returned as an object to stringify on the far side, so
 * the bytes that land in the doc are the ones Rust produced and the fold reads them
 * back with the same serde definition. Nothing in the path re-encodes.
 *
 * `attachment` endorses one FILE of the post rather than the post, named by its content
 * hash. It goes into the reference too when there is one, so the self-check reproduces
 * the right subject — a record whose attachment field was dropped would otherwise read as
 * an endorsement of the whole post.
 *
 * `reference_did_dht` is what chooses the visibility tier. Passing the channel author's
 * did:dht makes the record navigable and is correct ONLY for a public subject; passing
 * nothing publishes the subject hash alone, which is the answer for an unlisted or
 * private one — where a reference would give away the channel, and that it exists.
 *
 * `now` comes from the caller: `SystemTime::now()` panics on wasm32, and this is the
 * same reason the manifest transforms take their timestamp as an argument.
 * @param {string} app_key_hex
 * @param {string} kind
 * @param {string} channel_id
 * @param {string} published_at
 * @param {string} version
 * @param {string | null | undefined} reference_did_dht
 * @param {string | null | undefined} attachment
 * @param {string} now
 * @returns {string}
 */
export function sign_endorsement(app_key_hex, kind, channel_id, published_at, version, reference_did_dht, attachment, now) {
    let deferred10_0;
    let deferred10_1;
    try {
        const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(channel_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(published_at, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(version, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        var ptr5 = isLikeNone(reference_did_dht) ? 0 : passStringToWasm0(reference_did_dht, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len5 = WASM_VECTOR_LEN;
        var ptr6 = isLikeNone(attachment) ? 0 : passStringToWasm0(attachment, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(now, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len7 = WASM_VECTOR_LEN;
        const ret = wasm.sign_endorsement(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7);
        var ptr9 = ret[0];
        var len9 = ret[1];
        if (ret[3]) {
            ptr9 = 0; len9 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred10_0 = ptr9;
        deferred10_1 = len9;
        return getStringFromWasm0(ptr9, len9);
    } finally {
        wasm.__wbindgen_free(deferred10_0, deferred10_1, 1);
    }
}

export function start() {
    wasm.start();
}

/**
 * Start the channel-doc serve loop in this tab.
 *
 * Serves each owned channel as a live replica and keeps a read ticket published, so a
 * subscriber is pushed new posts rather than polling for them. It copies the sealed
 * manifest out of the main doc verbatim, so it needs no Sia session and never sees a
 * channel's content.
 * @param {string} app_key_hex
 * @param {number} cadence_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_channel_doc_loop(app_key_hex, cadence_secs, on_pass) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.start_channel_doc_loop(ptr0, len0, cadence_secs, on_pass);
    return ret;
}

/**
 * Start the channel live-sync loop in this tab.
 *
 * Imports each subscribed channel's doc from its author and writes what arrives into
 * `sub/<channelID>` — the same record the polling rung writes, so whatever renders is
 * already watching it.
 * @param {string} app_key_hex
 * @param {number} cadence_secs
 * @param {number} retry_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_channel_sync_loop(app_key_hex, cadence_secs, retry_secs, on_pass) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.start_channel_sync_loop(ptr0, len0, cadence_secs, retry_secs, on_pass);
    return ret;
}

/**
 * Start the engagement loop in this tab — read what the graph endorsed, hold what
 * verifies, publish a tally per subject.
 *
 * The same loop a desktop runs, from the same crate. A tab reaches the network exactly as
 * well while it is open, so there is nothing about crawling that differs by device; what
 * differs is only how long it stays open to keep doing it.
 * @param {string} app_key_hex
 * @param {number} cadence_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_engagement_loop(app_key_hex, cadence_secs, on_pass) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.start_engagement_loop(ptr0, len0, cadence_secs, on_pass);
    return ret;
}

/**
 * Start the identity-publishing loop in this tab — one packet under the did:dht key
 * carrying the directory pointer, the doc namespace, and every live endpoint.
 *
 * A tab publishes the same record a desktop does, from the same crate, because both
 * assemble it from the doc rather than from what they happen to know locally. That's
 * what stopped them overwriting each other.
 * @param {string} app_key_hex
 * @param {string} namespace_id
 * @param {number} cadence_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_identity_loop(app_key_hex, namespace_id, cadence_secs, on_pass) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(namespace_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.start_identity_loop(ptr0, len0, ptr1, len1, cadence_secs, on_pass);
    return ret;
}

/**
 * Start this instance's registration loop in this tab.
 *
 * A tab is a real endpoint of this identity — it can be synced with and dialed over
 * its relay — so it belongs in the published set while it's open. It registers as NOT
 * durable, which is the honest difference: a desktop stays up, a tab doesn't, and a
 * peer choosing among endpoints should know which is which.
 * @param {number} cadence_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_instance_loop(cadence_secs, on_pass) {
    const ret = wasm.start_instance_loop(cadence_secs, on_pass);
    return ret;
}

/**
 * Start the Curator's locator keep-alive loop in this tab.
 *
 * The same loop the desktop runs, and it matters here for the same reason: an owned
 * channel whose locator ages off the DHT stops resolving for its subscribers, and a
 * tab is a full instance of the Curator rather than a lesser one. Uptime is what
 * differs — a tab republishes while it's open, a desktop while it's on.
 *
 * Needs no Sia session: republishing re-signs a pointer that already names its object.
 * @param {string} app_key_hex
 * @param {number} cadence_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_keep_alive_loop(app_key_hex, cadence_secs, on_pass) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.start_keep_alive_loop(ptr0, len0, cadence_secs, on_pass);
    return ret;
}

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
 * @param {string} app_key_hex
 * @param {number} cadence_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_pull_loop(app_key_hex, cadence_secs, on_pass) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.start_pull_loop(ptr0, len0, cadence_secs, on_pass);
    return ret;
}

/**
 * Start the instance rendezvous loop in this tab — advertise where this tab can be
 * reached, and sync with the identity's other instances.
 *
 * A tab is a full peer here, not a client: it publishes its own ticket and can be
 * synced FROM as well as syncing TO. It advertises as not-durable, which is the honest
 * difference — a peer choosing among endpoints should know which one will still be
 * there in an hour.
 * @param {string} app_key_hex
 * @param {number} cadence_secs
 * @param {number} retry_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_rendezvous_loop(app_key_hex, cadence_secs, retry_secs, on_pass) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.start_rendezvous_loop(ptr0, len0, cadence_secs, retry_secs, on_pass);
    return ret;
}

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
 * @param {string} app_key_hex
 * @param {number} cadence_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_repack_loop(app_key_hex, cadence_secs, on_pass) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.start_repack_loop(ptr0, len0, cadence_secs, on_pass);
    return ret;
}

/**
 * Start the doc-to-Sia snapshot loop in this tab.
 *
 * The identity's durability floor: whatever is in the doc, mirrored to Sia and named
 * by a published locator. One writer, reading the doc — it replaces a snapshot that
 * two React effects each took on their own debounce, racing on one pointer.
 * @param {string} app_key_hex
 * @param {number} cadence_secs
 * @param {number} settle_secs
 * @param {Function} on_pass
 * @returns {Promise<void>}
 */
export function start_snapshot_loop(app_key_hex, cadence_secs, settle_secs, on_pass) {
    const ptr0 = passStringToWasm0(app_key_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.start_snapshot_loop(ptr0, len0, cadence_secs, settle_secs, on_pass);
    return ret;
}

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
 * @param {string} ticket
 * @param {Function} on_event
 * @returns {Promise<void>}
 */
export function start_sync(ticket, on_event) {
    const ptr0 = passStringToWasm0(ticket, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.start_sync(ptr0, len0, on_event);
    return ret;
}

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
 * @returns {any}
 */
export function status() {
    const ret = wasm.status();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

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
 * @param {Function} on_change
 * @returns {Promise<void>}
 */
export function subscribe_doc_changes(on_change) {
    const ret = wasm.subscribe_doc_changes(on_change);
    return ret;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_boolean_get_fa956cfa2d1bd751: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_c25d447a39f5578f: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_string_get_b0ca35b86a603356: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_fffb441def202758: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_abort_8bae0f33e7833997: function(arg0) {
            arg0.abort();
        },
        __wbg_abort_eee9248a6d680839: function(arg0, arg1) {
            arg0.abort(arg1);
        },
        __wbg_addEventListener_c33b246adf950d7c: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.addEventListener(getStringFromWasm0(arg1, arg2), arg3);
        }, arguments); },
        __wbg_append_01c74e5c6b58aa64: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_arrayBuffer_3b637f0fa65c5351: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_body_18c9f2ac15ead4b2: function(arg0) {
            const ret = arg0.body;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_buffer_54b87055582c8a81: function(arg0) {
            const ret = arg0.buffer;
            return ret;
        },
        __wbg_byobRequest_06b654bb15590436: function(arg0) {
            const ret = arg0.byobRequest;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_byteLength_41862ca4020b9c43: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_byteOffset_d42e18c4441f628b: function(arg0) {
            const ret = arg0.byteOffset;
            return ret;
        },
        __wbg_call_44b7209e1e252e6a: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            const ret = arg0.call(arg1, arg2, arg3, arg4);
            return ret;
        }, arguments); },
        __wbg_call_8a2dd23819f8a60a: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_e3b662382210db98: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_cancel_3983a93e24cc66b3: function(arg0) {
            const ret = arg0.cancel();
            return ret;
        },
        __wbg_catch_c1a60df4c30d76d3: function(arg0, arg1) {
            const ret = arg0.catch(arg1);
            return ret;
        },
        __wbg_clearTimeout_113b1cde814ec762: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_clearTimeout_1ccca1faf41fc6f8: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_clearTimeout_47a40e3be01ed7a3: function() { return handleError(function (arg0, arg1) {
            arg0.clearTimeout(arg1);
        }, arguments); },
        __wbg_clearTimeout_6b8d9a38b9263d65: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_close_249a23304523681b: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_close_72d318d9c16e83ef: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_close_9aa4d8117c23924b: function(arg0) {
            arg0.close();
        },
        __wbg_close_c65ca0257e895318: function() { return handleError(function (arg0) {
            arg0.close();
        }, arguments); },
        __wbg_closed_90dc91afa732ed57: function(arg0) {
            const ret = arg0.closed;
            return ret;
        },
        __wbg_code_1fc52b4142a112ac: function(arg0) {
            const ret = arg0.code;
            return ret;
        },
        __wbg_code_cb4327cfc515673b: function(arg0) {
            const ret = arg0.code;
            return ret;
        },
        __wbg_createBidirectionalStream_f9081daa37bad3ee: function(arg0) {
            const ret = arg0.createBidirectionalStream();
            return ret;
        },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_data_328de4280640da92: function(arg0) {
            const ret = arg0.data;
            return ret;
        },
        __wbg_done_0006eceb5b1c41df: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_done_89b2b13e91a60321: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_enqueue_6d83b4c6281bafd6: function() { return handleError(function (arg0, arg1) {
            arg0.enqueue(arg1);
        }, arguments); },
        __wbg_entries_900cefd6f70eb290: function(arg0) {
            const ret = arg0.entries();
            return ret;
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_fetch_9dad4fe911207b37: function(arg0) {
            const ret = fetch(arg0);
            return ret;
        },
        __wbg_fetch_b5951fc96f52f786: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_fetch_c6486a0142348bc8: function(arg0) {
            const ret = fetch(arg0);
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_getRandomValues_cc7f052a444bb2ce: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getReader_7455d080fa48369b: function(arg0) {
            const ret = arg0.getReader();
            return ret;
        },
        __wbg_getReader_9facd4f899beac89: function() { return handleError(function (arg0) {
            const ret = arg0.getReader();
            return ret;
        }, arguments); },
        __wbg_getTime_d6f070c088c9b5ed: function(arg0) {
            const ret = arg0.getTime();
            return ret;
        },
        __wbg_getWriter_d71a99bcd847ccef: function() { return handleError(function (arg0) {
            const ret = arg0.getWriter();
            return ret;
        }, arguments); },
        __wbg_get_507a50627bffa49b: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_78f252d074a84d0b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_c7eb1f358a7654df: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_done_670108eb06ecbe46: function(arg0) {
            const ret = arg0.done;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg_get_unchecked_6e0ad6d2a41b06f6: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_value_f465f5be30aa0963: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_has_8374cf06984d8bfc: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.has(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_headers_cf9c80f30e2a4eff: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_4480b9e0068a8adb: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Blob_c6523f92a32c8695: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Blob;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Error_1fdac9f13a8181ba: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Error;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Response_c8b64b2256f01bec: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_309b927aaf7a3fc7: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_0677c962b281d01a: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_iterator_6f722e4a93058b71: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_370319915dc99107: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_message_8326fb1d549bebc5: function(arg0) {
            const ret = arg0.message;
            return ret;
        },
        __wbg_message_fb0e6e7854e6ea7a: function(arg0, arg1) {
            const ret = arg1.message;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_0_3da9e97f24fc69be: function() {
            const ret = new Date();
            return ret;
        },
        __wbg_new_0d809930cd1354c6: function() { return handleError(function () {
            const ret = new Headers();
            return ret;
        }, arguments); },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_4339b2a2675a03e3: function() { return handleError(function () {
            const ret = new AbortController();
            return ret;
        }, arguments); },
        __wbg_new_aec3e25493d729fe: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h08f43aa7048968fb(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_b667d279fd5aa943: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_bf8729ffe10e9ee7: function() { return handleError(function (arg0, arg1) {
            const ret = new WebSocket(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_new_cd45aabdf6073e84: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_da52cf8fe3429cb2: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_from_slice_77cdfb7977362f3c: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_1824d93f294193e5: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h08f43aa7048968fb(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_with_byte_offset_and_length_54c7724ee3ec7d82: function(arg0, arg1, arg2) {
            const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_new_with_length_e6785c33c8e4cce8: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_options_5b1cc213336d0b4c: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new WebTransport(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_new_with_str_and_init_d95cbe11ce28e65e: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_new_with_str_sequence_2de2f569c29910ad: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new WebSocket(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_next_6dbf2c0ac8cde20f: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_71f2aa1cb3d1e37e: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_86c0d4ba3fa605b8: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
            const ret = arg0.performance;
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_protocol_14b3b1c4bf71cd4a: function(arg0, arg1) {
            const ret = arg1.protocol;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_d2ae3af0c1217ae6: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queueMicrotask_0ab5b2d2393e99b9: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_6a09b7bc46549209: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_read_8afa15f12a160ef8: function(arg0) {
            const ret = arg0.read();
            return ret;
        },
        __wbg_readable_41ceb106ca6ebcbe: function(arg0) {
            const ret = arg0.readable;
            return ret;
        },
        __wbg_readyState_50bc38c2a9e83db6: function(arg0) {
            const ret = arg0.readyState;
            return ret;
        },
        __wbg_ready_e4dad560377c42e6: function(arg0) {
            const ret = arg0.ready;
            return ret;
        },
        __wbg_reason_5dc8e429d537d6a9: function(arg0, arg1) {
            const ret = arg1.reason;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_releaseLock_5b92874cad775644: function(arg0) {
            arg0.releaseLock();
        },
        __wbg_removeEventListener_eb8291c80ca9056d: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            arg0.removeEventListener(getStringFromWasm0(arg1, arg2), arg3);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_resolve_2191a4dfe481c25b: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_respond_510e32df8aeb6817: function() { return handleError(function (arg0, arg1) {
            arg0.respond(arg1 >>> 0);
        }, arguments); },
        __wbg_send_a321b376d40ec867: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.send(getArrayU8FromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_send_df98dd5ede9b3f4d: function() { return handleError(function (arg0, arg1, arg2) {
            arg0.send(getStringFromWasm0(arg1, arg2));
        }, arguments); },
        __wbg_setTimeout_30be5552e4410378: function(arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        },
        __wbg_setTimeout_6613a51400c1bf9f: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.setTimeout(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_setTimeout_ef24d2fc3ad97385: function() { return handleError(function (arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_setTimeout_f757f00851f76c42: function(arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        },
        __wbg_set_4d7dd76f3dae2926: function(arg0, arg1, arg2) {
            arg0.set(getArrayU8FromWasm0(arg1, arg2));
        },
        __wbg_set_8535240470bf2500: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_binaryType_a37b086c78ca7c29: function(arg0, arg1) {
            arg0.binaryType = __wbindgen_enum_BinaryType[arg1];
        },
        __wbg_set_body_029f2d171e0a005f: function(arg0, arg1) {
            arg0.body = arg1;
        },
        __wbg_set_cache_b4a740b195c051f4: function(arg0, arg1) {
            arg0.cache = __wbindgen_enum_RequestCache[arg1];
        },
        __wbg_set_credentials_bb34a40189e3b43b: function(arg0, arg1) {
            arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
        },
        __wbg_set_handle_event_dd6bc370a8cb4486: function(arg0, arg1) {
            arg0.handleEvent = arg1;
        },
        __wbg_set_headers_9c61d123c3ee1f10: function(arg0, arg1) {
            arg0.headers = arg1;
        },
        __wbg_set_method_5532d59b92d76467: function(arg0, arg1, arg2) {
            arg0.method = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_mode_66c79886ad78fc05: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_RequestMode[arg1];
        },
        __wbg_set_onclose_f706475385ecce07: function(arg0, arg1) {
            arg0.onclose = arg1;
        },
        __wbg_set_onerror_9f5773fd31512333: function(arg0, arg1) {
            arg0.onerror = arg1;
        },
        __wbg_set_onmessage_836d2f72130b4706: function(arg0, arg1) {
            arg0.onmessage = arg1;
        },
        __wbg_set_onopen_4f65470ae522a61a: function(arg0, arg1) {
            arg0.onopen = arg1;
        },
        __wbg_set_signal_c4ef8faddb4c1446: function(arg0, arg1) {
            arg0.signal = arg1;
        },
        __wbg_signal_dad7cb35193abd31: function(arg0) {
            const ret = arg0.signal;
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_c45b3b9b3033184a: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_stringify_b54333f60f1e4dad: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(arg0);
            return ret;
        }, arguments); },
        __wbg_subarray_3ed232c8a6baee09: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_text_d3a29f7525a132c3: function() { return handleError(function (arg0) {
            const ret = arg0.text();
            return ret;
        }, arguments); },
        __wbg_then_16d107c451e9905d: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_6ec10ae38b3e92f7: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_toISOString_706fbe321055ee58: function(arg0) {
            const ret = arg0.toISOString();
            return ret;
        },
        __wbg_url_a410c0bec2fb1b2c: function(arg0, arg1) {
            const ret = arg1.url;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_url_abdb8fb08377f8c0: function(arg0, arg1) {
            const ret = arg1.url;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_value_a5d5488a9589444a: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_value_c43150504c8e7894: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbg_view_21f1d4a4f175dfa9: function(arg0) {
            const ret = arg0.view;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_wasClean_3c7aa2335da09e74: function(arg0) {
            const ret = arg0.wasClean;
            return ret;
        },
        __wbg_writable_c905da49f8095567: function(arg0) {
            const ret = arg0.writable;
            return ret;
        },
        __wbg_write_f6dc0059c3feedce: function(arg0, arg1) {
            const ret = arg0.write(arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 1982, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 5876, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h9c38374c5ff5ba70);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 7928, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hc5f3e21d0efe8974);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("CloseEvent")], shim_idx: 4607, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__ha8ba71d4db3f24d7);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("MessageEvent")], shim_idx: 6533, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hd745e8189b95fcf4);
            return ret;
        },
        __wbindgen_cast_0000000000000006: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("WebTransportBidirectionalStream")], shim_idx: 1982, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7_5);
            return ret;
        },
        __wbindgen_cast_0000000000000007: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [NamedExternref("undefined")], shim_idx: 1982, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7_6);
            return ret;
        },
        __wbindgen_cast_0000000000000008: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 2216, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h43ae6dd74759854d);
            return ret;
        },
        __wbindgen_cast_0000000000000009: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 5833, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h5a55095f3e22c2db);
            return ret;
        },
        __wbindgen_cast_000000000000000a: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 6062, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h786b4ed5039223cd);
            return ret;
        },
        __wbindgen_cast_000000000000000b: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 6090, ret: Unit, inner_ret: Some(Unit) }, mutable: false }) -> Externref`.
            const ret = makeClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hfd95e48486b082ea);
            return ret;
        },
        __wbindgen_cast_000000000000000c: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 7896, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__ha3a167bd92644a00);
            return ret;
        },
        __wbindgen_cast_000000000000000d: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_000000000000000e: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_000000000000000f: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000010: function(arg0, arg1) {
            var v0 = getArrayU8FromWasm0(arg0, arg1).slice();
            wasm.__wbindgen_free(arg0, arg1 * 1, 1);
            // Cast intrinsic for `Vector(U8) -> Externref`.
            const ret = v0;
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./pin_core_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__h43ae6dd74759854d(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__h43ae6dd74759854d(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h5a55095f3e22c2db(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__h5a55095f3e22c2db(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h786b4ed5039223cd(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__h786b4ed5039223cd(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__hfd95e48486b082ea(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__hfd95e48486b082ea(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__ha3a167bd92644a00(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__ha3a167bd92644a00(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h9c38374c5ff5ba70(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__h9c38374c5ff5ba70(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__ha8ba71d4db3f24d7(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__ha8ba71d4db3f24d7(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__hd745e8189b95fcf4(arg0, arg1, arg2) {
    wasm.wasm_bindgen__convert__closures_____invoke__hd745e8189b95fcf4(arg0, arg1, arg2);
}

function wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__hc5f3e21d0efe8974(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__hc5f3e21d0efe8974(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7_5(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7_5(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7_6(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h095b0027783d48e7_6(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h08f43aa7048968fb(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h08f43aa7048968fb(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_BinaryType = ["blob", "arraybuffer"];


const __wbindgen_enum_ReadableStreamType = ["bytes"];


const __wbindgen_enum_RequestCache = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];


const __wbindgen_enum_RequestCredentials = ["omit", "same-origin", "include"];


const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];
const IntoUnderlyingByteSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingbytesource_free(ptr, 1));
const IntoUnderlyingSinkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsink_free(ptr, 1));
const IntoUnderlyingSourceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsource_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        try {
            return f(state.a, state.b, ...args);
        } finally {
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('pin_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
