// The pin-core Sia bindings, exercised through the real wasm module.
//
// Sia is the one substrate whose migration the credential-free tiers can't fully
// cover: every byte operation needs a real AppKey and a live indexer. But the parts
// that don't — phrase handling, the not-connected guards, argument validation — are
// enough to prove the BOUNDARY works: that the wasm carries the Sia layer, that the
// async bindings marshal, that Rust `String` errors arrive as catchable JS errors,
// and that `Option<String>` comes back as undefined rather than something exotic.
//
// That is the safety net the later commits lean on. Without it the bindings would be
// compile-verified only, and the first thing to actually run them would be the app.

import { describe, expect, it } from 'vitest'
import {
  sia_app_key_hex,
  sia_connect,
  sia_download_item,
  sia_generate_recovery_phrase,
  sia_is_connected,
  sia_register,
  sia_validate_recovery_phrase,
  sia_wait_for_approval,
} from '../../crates/pin-core/pkg/pin_core.js'

describe('recovery phrases', () => {
  it('generates a twelve-word phrase that validates', () => {
    const phrase = sia_generate_recovery_phrase()
    expect(phrase.split(/\s+/)).toHaveLength(12)
    expect(() => sia_validate_recovery_phrase(phrase)).not.toThrow()
  })

  it('generates a different phrase each time', () => {
    expect(sia_generate_recovery_phrase()).not.toBe(
      sia_generate_recovery_phrase(),
    )
  })

  // The composer validates as the user types, so the message is user-facing.
  it('rejects a malformed phrase with a readable reason', () => {
    expect(() =>
      sia_validate_recovery_phrase('clearly not a recovery phrase'),
    ).toThrow(/recovery phrase:/)
  })
})

describe('before a session is connected', () => {
  it('reports itself disconnected and holds no key', async () => {
    await expect(sia_is_connected()).resolves.toBe(false)
    // Option<String> — undefined rather than null or an empty string.
    await expect(sia_app_key_hex()).resolves.toBeUndefined()
  })

  // A Rust `Err(String)` has to surface as a rejection carrying that text, since the
  // whole surface reports failure that way.
  it('rejects an operation that needs a session', async () => {
    await expect(sia_download_item('sia://whatever')).rejects.toThrow(
      /not connected/,
    )
  })

  it('rejects a malformed app key before attempting any network call', async () => {
    await expect(sia_connect('not-hex', 'https://sia.storage')).rejects.toThrow(
      /32-byte hex/,
    )
  })
})

// The connect flow is a typestate in Rust, so calling it out of order can't be a
// silent no-op — it has to come back as an error the screens can act on.
describe('the connect flow out of order', () => {
  it('will not wait for approval that was never requested', async () => {
    await expect(sia_wait_for_approval()).rejects.toThrow(
      /no connection request in progress/,
    )
  })

  it('will not register without an approved connection', async () => {
    const phrase = sia_generate_recovery_phrase()
    await expect(sia_register(phrase)).rejects.toThrow(
      /no approved connection to register/,
    )
  })
})
