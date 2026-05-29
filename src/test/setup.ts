import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { afterEach } from 'vitest'

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
if (typeof Blob !== 'undefined' && typeof Blob.prototype.stream !== 'function') {
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
