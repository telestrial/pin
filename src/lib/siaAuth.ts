// The Sia connect flow, driven from the screens.
//
// The session lives in Rust (crates/pin-sia) rather than in a builder object held
// across three React screens. It has to: `Builder` is a typestate whose steps each
// consume the value and return the next state, so it cannot be handed to a component
// and kept in a ref. The screens call these in order and hold nothing.
//
// Runs in wasm on both platforms. The flow is plain HTTP to the indexer — not the
// byte path that needed moving out of the webview — and what it yields is an AppKey
// hex, which `connectSiaClient` then routes to whichever client the platform uses.
//
// A step out of order returns an error rather than silently doing nothing, so the
// screens can surface it instead of appearing to hang.

import {
  sia_generate_recovery_phrase,
  sia_register,
  sia_request_connection,
  sia_validate_recovery_phrase,
  sia_wait_for_approval,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'

/** Begin a connection; returns the URL the user approves at. Starting again
 *  replaces any request already in progress. */
export async function requestSiaConnection(
  indexerURL: string,
): Promise<string> {
  await ensureWasm()
  return sia_request_connection(indexerURL)
}

/** Wait for the user to approve at the indexer.
 *
 *  One long call that polls internally until approval or expiry, so there is nothing
 *  to re-drive on a timer. Safe to call twice — a second call on an already-approved
 *  request returns — which matters because React mounts effects twice in strict mode.
 *
 *  A rejection is NOT retryable: the underlying builder is consumed by the attempt,
 *  so recovery means requesting a fresh connection. */
export async function waitForSiaApproval(): Promise<void> {
  await ensureWasm()
  return sia_wait_for_approval()
}

/** Finish registration with the recovery phrase; returns the AppKey hex to persist
 *  and hand to `connectSiaClient`. */
export async function registerSiaAccount(mnemonic: string): Promise<string> {
  await ensureWasm()
  return sia_register(mnemonic)
}

export async function generateRecoveryPhrase(): Promise<string> {
  await ensureWasm()
  return sia_generate_recovery_phrase()
}

/** Resolves for a well-formed phrase, rejects with the reason otherwise. */
export async function validateRecoveryPhrase(phrase: string): Promise<void> {
  await ensureWasm()
  sia_validate_recovery_phrase(phrase)
}
