// The channel round-trip MUST run natively on desktop.
//
// This is a regression guard for a real break, not a hypothetical: when the round-trip
// first moved into Rust it called pin-core's wasm on both platforms, and on desktop the
// wasm Sia session is never connected — `connectSiaClient` hands the AppKey to the native
// backend instead. So every channel read on desktop failed instantly with "Sia is not
// connected", while web was perfectly green.
//
// The integration tier can't catch it: it runs non-Tauri, so it always takes the web path.
// Hence a unit test that flips the platform.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./openExternal', () => ({ inTauri: () => true }))

const publishLocator = vi.fn(async () => ({
  locatorKey: 'k',
  objectId: 'id',
  itemURL: 'sia://x',
}))
const resolveLocator = vi.fn(async () => null)
const republishPointer = vi.fn(async () => {})

vi.mock('./tauriChannelLocator', () => ({
  makeTauriChannelLocator: async () => ({
    publishLocator,
    resolveLocator,
    republishPointer,
  }),
}))

// If the seam reaches wasm under Tauri, these throw rather than silently passing —
// which is the failure mode being guarded against.
vi.mock('../core/wasm', () => ({
  ensureWasm: async () => {
    throw new Error('the wasm session is not connected on desktop')
  },
}))
vi.mock('../../crates/pin-core/pkg/pin_core.js', () => ({
  channel_publish: () => {
    throw new Error('reached wasm on desktop')
  },
  channel_resolve: () => {
    throw new Error('reached wasm on desktop')
  },
  channel_republish_pointer: () => {
    throw new Error('reached wasm on desktop')
  },
  channel_open_blob: () => 'ignored',
}))

describe('the channel round-trip under Tauri', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('publishes through the native backend, not the WebView', async () => {
    const { publishLocator: publish } = await import('./channelLocatorNative')
    const key = new Uint8Array(32)
    await expect(publish(key, '{}')).resolves.toMatchObject({ objectId: 'id' })
    expect(publishLocator).toHaveBeenCalledWith(key, '{}')
  })

  it('resolves and republishes through the native backend too', async () => {
    const mod = await import('./channelLocatorNative')
    const key = new Uint8Array(32)
    await expect(mod.resolveLocator(key)).resolves.toBeNull()
    await expect(mod.republishPointer(key, 'sia://x')).resolves.toBeUndefined()
    expect(resolveLocator).toHaveBeenCalledOnce()
    expect(republishPointer).toHaveBeenCalledWith(key, 'sia://x')
  })
})
