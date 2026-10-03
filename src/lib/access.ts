// Asking to read a private channel, from the asker's side.
//
// The request is signed in Rust — by the Curator's engine on desktop, the tab's on web — and
// kept as this identity's own in the doc, where the deliver loop finds it and knocks it to
// the channel's author until it lands. Withdrawing is a newer signed request, so it travels
// the same road and outranks the one it takes back.

import {
  access_request,
  join_request_collection,
} from '../../crates/pin-core/pkg/pin_core.js'
import { ensureWasm } from '../core/wasm'
import { getRecord } from './docs'
import { inTauri } from './openExternal'

/** A request to read a private channel, or its withdrawal, as its asker signed it. */
export type JoinRequest = {
  channelID: string
  author: string
  actor: string
  encKey: string
  createdAt: string
  withdrawn?: boolean
  sig: string
}

/** Ask to read a private channel, or withdraw the request (`withdrawn`). */
export async function requestAccess(
  appKeyHex: string,
  channelKey: Uint8Array,
  author: string,
  withdrawn: boolean,
): Promise<JoinRequest> {
  const nowIso = new Date().toISOString()
  if (inTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<JoinRequest>('access_request', {
      appKeyHex,
      channelKey: Array.from(channelKey),
      author,
      withdrawn,
      nowIso,
    })
  }
  await ensureWasm()
  return JSON.parse(
    await access_request(appKeyHex, channelKey, author, withdrawn, nowIso),
  ) as JoinRequest
}

/** This identity's newest request about one channel, or null when it has never asked. */
export async function readMyRequest(
  channelID: string,
): Promise<JoinRequest | null> {
  await ensureWasm()
  const bytes = await getRecord(join_request_collection(), channelID)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as JoinRequest
  } catch {
    return null
  }
}

/** Whether a request is standing: made, and not taken back. */
export function isStanding(request: JoinRequest | null): boolean {
  return !!request && !request.withdrawn
}
