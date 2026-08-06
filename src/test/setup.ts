import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { afterEach, beforeAll } from 'vitest'
import { ensureWasm } from '../core/wasm'

// Instantiate pin-core's wasm from disk before any test runs.
//
// The browser lets wasm-bindgen fetch the .wasm sitting next to its JS glue; Node has
// no such URL, so we hand it the bytes. Seeding the shared init here means production
// code calls plain `ensureWasm()` and gets the already-resolved promise — no test-only
// branch inside the module under test.
//
// This is what lets the fast tiers cover Rust-backed code at all, which matters more
// as the data layer moves into pin-core: the existing suites stay the safety net for
// each migration instead of being mocked away.
beforeAll(async () => {
  await ensureWasm(
    readFileSync(resolve('crates/pin-core/pkg/pin_core_bg.wasm')),
  )
})

// RTL's auto-cleanup is wired to global hooks (jest/vitest globals). With
// `globals: false` in vitest.config.ts we have to register it ourselves so
// each test starts with an empty DOM. Without this, the previous test's
// render lingers and `screen.getByText(...)` returns the stale node.
afterEach(() => {
  cleanup()
})

// jsdom's Blob doesn't ship .stream(); core/sia.ts uses
// `new Blob([bytes]).stream()` to feed sdk.upload. Polyfill it with a
// minimal ReadableStream that emits the blob's bytes in one chunk.
if (
  typeof Blob !== 'undefined' &&
  typeof Blob.prototype.stream !== 'function'
) {
  Object.defineProperty(Blob.prototype, 'stream', {
    configurable: true,
    writable: true,
    value: function stream(this: Blob): ReadableStream<Uint8Array> {
      const blob = this
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const buf = await blob.arrayBuffer()
          controller.enqueue(new Uint8Array(buf))
          controller.close()
        },
      })
    },
  })
}

// jsdom doesn't ship `Uint8Array.fromHex` (the TC39 base64/hex proposal), which is
// how every AppKey reaches an HKDF call. Production has it; without it here, any code
// path that derives from the stored key throws in tests — and because those paths
// mostly catch and degrade, the failure surfaces as a quiet wrong answer rather than
// an error. Polyfill it so the fast tiers can actually cover them.
if (
  typeof (Uint8Array as unknown as { fromHex?: unknown }).fromHex !== 'function'
) {
  Object.defineProperty(Uint8Array, 'fromHex', {
    configurable: true,
    writable: true,
    value: (hex: string): Uint8Array => {
      if (hex.length % 2 !== 0) throw new SyntaxError('odd-length hex string')
      const out = new Uint8Array(hex.length / 2)
      for (let i = 0; i < out.length; i++) {
        const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
        if (Number.isNaN(byte)) throw new SyntaxError('invalid hex string')
        out[i] = byte
      }
      return out
    },
  })
}
