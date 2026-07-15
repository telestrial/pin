var exports = {};
/* @ts-self-types="./pkarr_js.d.ts" */

/**
 * Pkarr Client for publishing and resolving signed DNS packets
 */
 export class Client {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClientFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_client_free(ptr, 0);
    }
    /**
     * Get default relay URLs as JavaScript array
     * @returns {Array<any>}
     */
    static defaultRelays() {
        const ret = wasm.client_defaultRelays();
        return ret;
    }
    /**
     * Get the configured timeout in milliseconds
     * @returns {number}
     */
    getTimeout() {
        const ret = wasm.client_getTimeout(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create a new client with relay endpoints
     *
     * # Arguments
     * * `relays` - Optional array of relay URLs as strings. If not provided, default relays will be used
     * * `timeout_ms` - Controls the network timeouts for relay responses (optional, defaults to 30000 ms, min: 1000, max: 300000)
     * @param {Array<any> | null} [relays]
     * @param {number | null} [timeout_ms]
     */
    constructor(relays, timeout_ms) {
        const ret = wasm.client_new(isLikeNone(relays) ? 0 : addToExternrefTable0(relays), isLikeNone(timeout_ms) ? Number.MAX_SAFE_INTEGER : (timeout_ms) >>> 0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ClientFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Publish a signed packet to relays
     *
     * # Arguments
     * * `signed_packet` - The signed packet to publish
     * * `cas_timestamp` - Optional compare-and-swap timestamp in milliseconds
     * @param {SignedPacket} signed_packet
     * @param {number | null} [cas_timestamp]
     * @returns {Promise<void>}
     */
    publish(signed_packet, cas_timestamp) {
        _assertClass(signed_packet, SignedPacket);
        const ret = wasm.client_publish(this.__wbg_ptr, signed_packet.__wbg_ptr, !isLikeNone(cas_timestamp), isLikeNone(cas_timestamp) ? 0 : cas_timestamp);
        return ret;
    }
    /**
     * Resolve a public key to get the latest signed packet
     *
     * # Arguments
     * * `public_key_str` - The public key as a z-base32 string
     *
     * # Returns
     * * `Option<SignedPacket>` - The signed packet if found
     * @param {string} public_key_str
     * @returns {Promise<SignedPacket | undefined>}
     */
    resolve(public_key_str) {
        const ptr0 = passStringToWasm0(public_key_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.client_resolve(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Resolve the most recent signed packet for a public key
     *
     * # Arguments
     * * `public_key_str` - The public key as a z-base32 string
     *
     * # Returns
     * * `Option<SignedPacket>` - The most recent signed packet if found
     * @param {string} public_key_str
     * @returns {Promise<SignedPacket | undefined>}
     */
    resolveMostRecent(public_key_str) {
        const ptr0 = passStringToWasm0(public_key_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.client_resolveMostRecent(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) Client.prototype[Symbol.dispose] = Client.prototype.free;
exports.Client = Client;

/**
 * WASM-compatible wrapper for Keypair
 */
 export class Keypair {
    static __wrap(ptr) {
        const obj = Object.create(Keypair.prototype);
        obj.__wbg_ptr = ptr;
        KeypairFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        KeypairFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_keypair_free(ptr, 0);
    }
    /**
     * Create keypair from secret key bytes
     *
     * # Arguments
     * * `secret_key_bytes` - The 32-byte secret key
     * @param {Uint8Array} secret_key_bytes
     * @returns {Keypair}
     */
    static from_secret_key(secret_key_bytes) {
        const ptr0 = passArray8ToWasm0(secret_key_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.keypair_from_secret_key(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Keypair.__wrap(ret[0]);
    }
    /**
     * Get the public key as raw bytes (32 bytes)
     * @returns {Uint8Array}
     */
    public_key_bytes() {
        const ret = wasm.keypair_public_key_bytes(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the public key as a z-base32 encoded string
     *
     * This is the format used for pkarr public key identifiers
     * @returns {string}
     */
    public_key_string() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.keypair_public_key_string(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Generate a cryptographically secure random keypair
     */
    constructor() {
        const ret = wasm.keypair_random();
        this.__wbg_ptr = ret;
        KeypairFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get the secret key as raw bytes (32 bytes)
     *
     * # Security Warning
     * Keep secret key data secure and never transmit it over insecure channels
     * @returns {Uint8Array}
     */
    secret_key_bytes() {
        const ret = wasm.keypair_secret_key_bytes(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Keypair.prototype[Symbol.dispose] = Keypair.prototype.free;
exports.Keypair = Keypair;

/**
 * WASM-compatible wrapper for SignedPacket
 */
 export class SignedPacket {
    static __wrap(ptr) {
        const obj = Object.create(SignedPacket.prototype);
        obj.__wbg_ptr = ptr;
        SignedPacketFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SignedPacketFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_signedpacket_free(ptr, 0);
    }
    /**
     * Create a SignedPacketBuilder (static method)
     * @returns {SignedPacketBuilder}
     */
    static builder() {
        const ret = wasm.signedpacket_builder();
        return SignedPacketBuilder.__wrap(ret);
    }
    /**
     * Get the uncompressed (serialized) bytes of the signed packet
     *
     * This returns the full DNS packet structure as bytes, suitable for:
     * - Parsing with `SignedPacket.fromBytes()`
     * @returns {Uint8Array}
     */
    bytes() {
        const ret = wasm.signedpacket_bytes(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Get the compressed DNS packet bytes only
     *
     * This returns just the compressed DNS packet portion (without signature/timestamp),
     * which is suitable for:
     * - Direct DNS protocol operations
     * - Size analysis of the DNS content
     *
     * Note: This is only the DNS packet part, not the full pkarr format.
     * For relay publishing, use the packet directly with `client.publish()`.
     * For reconstruction, use `bytes()` instead.
     * @returns {Uint8Array}
     */
    compressedBytes() {
        const ret = wasm.signedpacket_compressedBytes(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Create a SignedPacket from uncompressed bytes
     *
     * # Arguments
     * * `bytes` - The uncompressed/serialized signed packet bytes (from `bytes()`)
     *
     * Note: This method expects uncompressed DNS packet bytes, not the compressed
     * pkarr format. Use `packet.bytes()` to get compatible bytes.
     * @param {Uint8Array} bytes
     * @returns {SignedPacket}
     */
    static fromBytes(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signedpacket_fromBytes(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SignedPacket.__wrap(ret[0]);
    }
    /**
     * Check if the packet contains any records
     * @returns {boolean}
     */
    isEmpty() {
        const ret = wasm.signedpacket_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Verify the cryptographic signature of this packet
     * @returns {boolean}
     */
    isValid() {
        const ret = wasm.signedpacket_isValid(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get the public key as a z-base32 string
     * @returns {string}
     */
    get publicKeyString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.signedpacket_publicKeyString(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the number of DNS records in this packet
     * @returns {number}
     */
    get recordCount() {
        const ret = wasm.signedpacket_recordCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the DNS records as a JavaScript array of objects
     * @returns {Array<any>}
     */
    get records() {
        const ret = wasm.signedpacket_records(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Get the timestamp in milliseconds since Unix epoch
     * @returns {number}
     */
    get timestampMs() {
        const ret = wasm.signedpacket_timestampMs(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) SignedPacket.prototype[Symbol.dispose] = SignedPacket.prototype.free;
exports.SignedPacket = SignedPacket;

/**
 * WASM-compatible wrapper for SignedPacketBuilder
 */
 export class SignedPacketBuilder {
    static __wrap(ptr) {
        const obj = Object.create(SignedPacketBuilder.prototype);
        obj.__wbg_ptr = ptr;
        SignedPacketBuilderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SignedPacketBuilderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_signedpacketbuilder_free(ptr, 0);
    }
    /**
     * Add an AAAA record (IPv6 address) to the packet
     *
     * # Arguments
     * * `name` - The domain name
     * * `address` - The IPv6 address as a string (e.g., "::1")
     * * `ttl` - Time to live in seconds
     * @param {string} name
     * @param {string} address
     * @param {number} ttl
     */
    addAAAARecord(name, address, ttl) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.signedpacketbuilder_addAAAARecord(this.__wbg_ptr, ptr0, len0, ptr1, len1, ttl);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Add an A record (IPv4 address) to the packet
     *
     * # Arguments
     * * `name` - The domain name
     * * `address` - The IPv4 address as a string (e.g., "192.168.1.1")
     * * `ttl` - Time to live in seconds
     * @param {string} name
     * @param {string} address
     * @param {number} ttl
     */
    addARecord(name, address, ttl) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(address, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.signedpacketbuilder_addARecord(this.__wbg_ptr, ptr0, len0, ptr1, len1, ttl);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Add a CNAME record to the packet
     *
     * # Arguments
     * * `name` - The domain name
     * * `target` - The target domain name
     * * `ttl` - Time to live in seconds
     * @param {string} name
     * @param {string} target
     * @param {number} ttl
     */
    addCnameRecord(name, target, ttl) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.signedpacketbuilder_addCnameRecord(this.__wbg_ptr, ptr0, len0, ptr1, len1, ttl);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Add an HTTPS record to the packet
     *
     * # Arguments
     * * `name` - The domain name
     * * `priority` - Service priority (0-65535)
     * * `target` - The target server domain name
     * * `ttl` - Time to live in seconds
     * * `params` - Optional JavaScript object containing service parameters
     *              Keys can be either numeric strings ("1", "3") or descriptive names ("alpn", "port")
     * @param {string} name
     * @param {number} priority
     * @param {string} target
     * @param {number} ttl
     * @param {object | null} [params]
     */
    addHttpsRecord(name, priority, target, ttl, params) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.signedpacketbuilder_addHttpsRecord(this.__wbg_ptr, ptr0, len0, priority, ptr1, len1, ttl, isLikeNone(params) ? 0 : addToExternrefTable0(params));
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Add an NS record to the packet
     *
     * # Arguments
     * * `name` - The domain name
     * * `nameserver` - The nameserver domain name
     * * `ttl` - Time to live in seconds
     * @param {string} name
     * @param {string} nameserver
     * @param {number} ttl
     */
    addNsRecord(name, nameserver, ttl) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(nameserver, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.signedpacketbuilder_addNsRecord(this.__wbg_ptr, ptr0, len0, ptr1, len1, ttl);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Add an SVCB (Service Binding) record to the packet
     *
     * # Arguments
     * * `name` - The domain name
     * * `priority` - Service priority (0-65535)
     * * `target` - The target server domain name
     * * `ttl` - Time to live in seconds
     * * `params` - Optional JavaScript object containing service parameters
     *              Keys can be either numeric strings ("1", "3") or descriptive names ("alpn", "port")
     * @param {string} name
     * @param {number} priority
     * @param {string} target
     * @param {number} ttl
     * @param {object | null} [params]
     */
    addSvcbRecord(name, priority, target, ttl, params) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.signedpacketbuilder_addSvcbRecord(this.__wbg_ptr, ptr0, len0, priority, ptr1, len1, ttl, isLikeNone(params) ? 0 : addToExternrefTable0(params));
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Add a TXT record to the packet
     *
     * # Arguments
     * * `name` - The domain name (e.g., "example" or "subdomain.example")
     * * `text` - The text content
     * * `ttl` - Time to live in seconds
     * @param {string} name
     * @param {string} text
     * @param {number} ttl
     */
    addTxtRecord(name, text, ttl) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.signedpacketbuilder_addTxtRecord(this.__wbg_ptr, ptr0, len0, ptr1, len1, ttl);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Build and sign the packet with the given keypair
     *
     * # Arguments
     * * `keypair` - The Keypair to sign with
     *
     * # Returns
     * * `SignedPacket` - The signed packet ready for publishing
     * @param {Keypair} keypair
     * @returns {SignedPacket}
     */
    buildAndSign(keypair) {
        _assertClass(keypair, Keypair);
        const ret = wasm.signedpacketbuilder_buildAndSign(this.__wbg_ptr, keypair.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SignedPacket.__wrap(ret[0]);
    }
    /**
     * Create a new builder instance (static method)
     * @returns {SignedPacketBuilder}
     */
    static builder() {
        const ret = wasm.signedpacketbuilder_builder();
        return SignedPacketBuilder.__wrap(ret);
    }
    /**
     * Clear all records from the builder
     */
    clear() {
        wasm.signedpacketbuilder_clear(this.__wbg_ptr);
    }
    /**
     * Create a new SignedPacketBuilder for WASM
     */
    constructor() {
        const ret = wasm.signedpacketbuilder_new();
        this.__wbg_ptr = ret;
        SignedPacketBuilderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set the timestamp for the packet (optional)
     *
     * # Arguments
     * * `timestamp_ms` - Timestamp in milliseconds since Unix epoch
     * @param {number} timestamp_ms
     */
    setTimestamp(timestamp_ms) {
        wasm.signedpacketbuilder_setTimestamp(this.__wbg_ptr, timestamp_ms);
    }
}
if (Symbol.dispose) SignedPacketBuilder.prototype[Symbol.dispose] = SignedPacketBuilder.prototype.free;
exports.SignedPacketBuilder = SignedPacketBuilder;

/**
 * Utility functions
 */
 export class Utils {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        UtilsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_utils_free(ptr, 0);
    }
    /**
     * Get default relay URLs
     * @returns {Array<any>}
     */
    static defaultRelays() {
        const ret = wasm.utils_defaultRelays();
        return ret;
    }
    /**
     * Format a DNS record value for display
     * @param {any} rdata
     * @returns {string}
     */
    static formatRecordValue(rdata) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.utils_formatRecordValue(rdata);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Validate a public key string
     * @param {string} public_key_str
     * @returns {boolean}
     */
    static validatePublicKey(public_key_str) {
        const ptr0 = passStringToWasm0(public_key_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.utils_validatePublicKey(ptr0, len0);
        return ret !== 0;
    }
}
if (Symbol.dispose) Utils.prototype[Symbol.dispose] = Utils.prototype.free;
exports.Utils = Utils;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_debug_string_07cb72cfcc952e2b: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_is_function_2f0fd7ceb86e64c5: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_5b22ff2418063a9c: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_eddc07a3efad52e6: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_244a92c34d3b6ec0: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_number_get_dd6d69a6079f26f1: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_965592073e5d848c: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_9c75d47bf9e7731e: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_158e43e869788cdc: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_abort_43913e33ecb83d0d: function(arg0, arg1) {
            arg0.abort(arg1);
        },
        __wbg_abort_87eb7f23cf4b73d1: function(arg0) {
            arg0.abort();
        },
        __wbg_append_8df396311184f750: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            arg0.append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
        }, arguments); },
        __wbg_arrayBuffer_87e3ac06d961f7a0: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_call_a41d6421b30a32c5: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_clearTimeout_1ccca1faf41fc6f8: function(arg0) {
            const ret = clearTimeout(arg0);
            return ret;
        },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_done_b1afd6201ac045e0: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_entries_83f42485034accab: function(arg0) {
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
        __wbg_fetch_1a030943aa8e0c38: function(arg0, arg1) {
            const ret = arg0.fetch(arg1);
            return ret;
        },
        __wbg_fetch_c6486a0142348bc8: function(arg0) {
            const ret = fetch(arg0);
            return ret;
        },
        __wbg_getRandomValues_76dfc69825c9c552: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_get_41476db20fef99a8: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_652f640b3b0b6e3e: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_unchecked_be562b1421656321: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_has_3a6f31f647e0ba22: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.has(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_headers_de17f740bce997ae: function(arg0) {
            const ret = arg0.headers;
            return ret;
        },
        __wbg_instanceof_Object_af9351f8f1c6f0c4: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Object;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Response_370b83aa6c17e88a: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_57d77acd50e4c44d: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_c6c6ef8308995bcf: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_keys_ee6179c15466c3ed: function(arg0) {
            const ret = Object.keys(arg0);
            return ret;
        },
        __wbg_length_0a6ce016dc1460b0: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_ba3c032602efe310: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_18865c63fa645c6f: function() { return handleError(function () {
            const ret = new Headers();
            return ret;
        }, arguments); },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_2fad8ca02fd00684: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_3baa8d9866155c79: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_51ff470dc2f61e27: function() { return handleError(function () {
            const ret = new AbortController();
            return ret;
        }, arguments); },
        __wbg_new_8454eee672b2ba6e: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_from_slice_5a173c243af2e823: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_1137602701dc87d4: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h63ba76388673f320(a, state0.b, arg0, arg1);
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
        __wbg_new_with_length_9011f5da794bf5d9: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_str_and_init_da311e12114f4d1e: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = new Request(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        }, arguments); },
        __wbg_next_aacee310bcfe6461: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_4f457f10f864aec5: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_fd4050e806e1d519: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_60a5366c0bb22a7d: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queueMicrotask_40ac6ffc2848ba77: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_queueMicrotask_74d092439f6494c1: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_resolve_9feb5d906ca62419: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_setTimeout_30be5552e4410378: function(arg0, arg1) {
            const ret = setTimeout(arg0, arg1);
            return ret;
        },
        __wbg_set_5337f8ac82364a3f: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_body_aaff4f5f9991f342: function(arg0, arg1) {
            arg0.body = arg1;
        },
        __wbg_set_cache_d1f2b7b4dfa39317: function(arg0, arg1) {
            arg0.cache = __wbindgen_enum_RequestCache[arg1];
        },
        __wbg_set_credentials_f31e4d30b974ce14: function(arg0, arg1) {
            arg0.credentials = __wbindgen_enum_RequestCredentials[arg1];
        },
        __wbg_set_headers_ae96049ea40e9eef: function(arg0, arg1) {
            arg0.headers = arg1;
        },
        __wbg_set_method_0eea8a5597775fa1: function(arg0, arg1, arg2) {
            arg0.method = getStringFromWasm0(arg1, arg2);
        },
        __wbg_set_mode_9fe47bff60a1580d: function(arg0, arg1) {
            arg0.mode = __wbindgen_enum_RequestMode[arg1];
        },
        __wbg_set_signal_8c5cf4c3b27bd8a8: function(arg0, arg1) {
            arg0.signal = arg1;
        },
        __wbg_signal_4643ce883b92b553: function(arg0) {
            const ret = arg0.signal;
            return ret;
        },
        __wbg_signedpacket_new: function(arg0) {
            const ret = SignedPacket.__wrap(arg0);
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_THIS_1c7f1bd6c6941fdb: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_e039bc914f83e74e: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_8bf8c48c28420ad5: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_6aeee9b51652ee0f: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_157e67ab07d01f8a: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_subarray_fbe3cef290e1fa43: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_text_de416916b5c06490: function() { return handleError(function (arg0) {
            const ret = arg0.text();
            return ret;
        }, arguments); },
        __wbg_then_20a157d939b514f5: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_then_5ef9b762bc91555c: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_url_a0e994e7d0317efc: function(arg0, arg1) {
            const ret = arg1.url;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_value_f852716acdeb3e82: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 366, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__h930d93b82aef289b);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 243, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hd829aedffccf0cf9);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
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
        "./pkarr_js_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__hd829aedffccf0cf9(arg0, arg1) {
    wasm.wasm_bindgen__convert__closures_____invoke__hd829aedffccf0cf9(arg0, arg1);
}

function wasm_bindgen__convert__closures_____invoke__h930d93b82aef289b(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__h930d93b82aef289b(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h63ba76388673f320(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h63ba76388673f320(arg0, arg1, arg2, arg3);
}


const __wbindgen_enum_RequestCache = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];


const __wbindgen_enum_RequestCredentials = ["omit", "same-origin", "include"];


const __wbindgen_enum_RequestMode = ["same-origin", "no-cors", "cors", "navigate"];
const ClientFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_client_free(ptr, 1));
const KeypairFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_keypair_free(ptr, 1));
const SignedPacketFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_signedpacket_free(ptr, 1));
const SignedPacketBuilderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_signedpacketbuilder_free(ptr, 1));
const UtilsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_utils_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
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
function decodeText(ptr, len) {
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

let wasm;
export async function initPkarr(wasmUrl) {
  const buf = await (await fetch(wasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(buf, __wbg_get_imports());
  wasm = instance.exports;
  wasm.__wbindgen_start();
  return wasm;
}
