// One initialization path for the pin-core wasm module.
//
// pin-core is becoming the app's data layer (see CLAUDE.md, the Rust-core arc), so
// more than one module needs it live: the doc engine binding does today, the crypto
// derivations do next, and the substrate migrations after that will too. They must
// all await the SAME init — wasm-bindgen keeps the instance in a module-level slot,
// so two independent callers racing `__wbg_init` is a re-instantiation, not a shared
// one. Memoizing here makes "is the wasm up?" a single question with a single answer.
//
// Lives in core/ rather than lib/ because core modules need it and core can't import
// lib (lib imports core; the reverse would be circular). It touches no React, no DOM,
// and no localStorage, so it keeps core's platform-agnostic contract.

import initWasm from '../../crates/pin-core/pkg/pin_core.js'

let ready: Promise<void> | null = null

/** Ensure the pin-core wasm module is instantiated, once per process.
 *
 *  `input` exists for environments with no `fetch`-able asset URL — notably the
 *  unit/integration tiers, where the test setup passes the bytes read off disk. The
 *  browser calls this with no argument and wasm-bindgen fetches the .wasm sitting
 *  next to its JS glue. Whoever calls first wins; everyone else awaits that promise. */
export function ensureWasm(input?: BufferSource): Promise<void> {
  if (!ready) ready = initWasm(input).then(() => undefined)
  return ready
}
