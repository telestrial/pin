// The settings record on the PDS — `dev.sia.pin.settings` at rkey `self`,
// mutable in place. This is the durable home for the user's channels +
// subscriptions (and the channel keys inside them). Living on the PDS as a
// single overwritten record is what dissolves the Sia settings-object
// proliferation / convergence / ghost-channel bug class: there's only ever
// one record, so there's no "which object is newest" race.
//
// The record body is ciphertext (encryptSettings — fixed-pad AES-GCM, so the
// public record leaks neither content nor channel/sub count via its size).
// The key is derived from the Sia AppKey (deriveSettingsKey), never the
// atproto identity, and is never shared.

import type { Agent } from '@atproto/api'
import { decryptSettings, encryptSettings } from './crypto'
import { type DispatchSettings, SETTINGS_VERSION } from './settings'

export const SETTINGS_LEXICON = 'dev.sia.pin.settings'
// Well-known rkey, parallel to dev.sia.pin.profile/self.
export const SETTINGS_RKEY = 'self'

export type SettingsRecord = {
  $type: typeof SETTINGS_LEXICON
  // base64 fixed-pad AES-GCM(JSON(DispatchSettings)). See crypto.encryptSettings.
  enc: string
  updatedAt: string
}

export type LoadedSettingsRecord = {
  settings: DispatchSettings
  // CID of the record we read — pass back to saveSettingsRecord as the
  // compare-and-swap guard for the next write.
  cid: string
}

// Read + decrypt the user's own settings record via their authenticated agent
// (their PDS, not a relay — authoritative). Returns null when no record exists
// yet or the body decodes to an unexpected version.
export async function loadSettingsRecord(
  agent: Agent,
  settingsKey: Uint8Array,
): Promise<LoadedSettingsRecord | null> {
  const read = await getRecordWithCid(agent, agent.assertDid)
  if (!read) return null
  const json = await decryptSettings(settingsKey, read.value.enc)
  const settings = JSON.parse(json) as DispatchSettings
  if (settings.version !== SETTINGS_VERSION) return null
  return { settings, cid: read.cid }
}

const MAX_CAS_RETRIES = 3

// Encrypt + write the settings record, mutable in place. swapRecord (CAS on
// the CID) serializes writes: a write based on a stale CID fails and we
// re-read the current CID and retry. Conflict resolution is last-writer-wins
// (we re-write the caller's full state) — true field-level merge across
// divergent concurrent writers is deferred to P4 (the journal / cross-device
// phase), where it belongs. Returns the new CID for the caller to track.
export async function saveSettingsRecord(
  agent: Agent,
  settingsKey: Uint8Array,
  settings: DispatchSettings,
  expectedCid: string | null,
): Promise<string> {
  const did = agent.assertDid
  const enc = await encryptSettings(settingsKey, JSON.stringify(settings))
  const record: SettingsRecord = {
    $type: SETTINGS_LEXICON,
    enc,
    updatedAt: settings.updatedAt,
  }

  let swapCid = expectedCid
  for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
    try {
      const res = await agent.com.atproto.repo.putRecord({
        repo: did,
        collection: SETTINGS_LEXICON,
        rkey: SETTINGS_RKEY,
        record,
        validate: false,
        // Omit swapRecord on the first write when we have no CID (upsert);
        // include it once we know the current CID so concurrent writers
        // can't blindly clobber.
        ...(swapCid ? { swapRecord: swapCid } : {}),
      })
      return res.data.cid
    } catch (err) {
      if (!isSwapError(err) || attempt === MAX_CAS_RETRIES) throw err
      // Stale CID — another writer got there first. Re-read the current CID
      // and retry (last-writer-wins; P4 will merge here).
      const current = await getRecordWithCid(agent, did)
      swapCid = current?.cid ?? null
    }
  }
  // Unreachable — the loop returns on success or throws on the last attempt.
  throw new Error('saveSettingsRecord: exhausted CAS retries')
}

export async function deleteSettingsRecord(agent: Agent): Promise<void> {
  await agent.com.atproto.repo.deleteRecord({
    repo: agent.assertDid,
    collection: SETTINGS_LEXICON,
    rkey: SETTINGS_RKEY,
  })
}

async function getRecordWithCid(
  agent: Agent,
  did: string,
): Promise<{ value: SettingsRecord; cid: string } | null> {
  try {
    const res = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: SETTINGS_LEXICON,
      rkey: SETTINGS_RKEY,
    })
    return { value: res.data.value as SettingsRecord, cid: res.data.cid ?? '' }
  } catch (err) {
    if (isRecordNotFoundError(err)) return null
    throw err
  }
}

function isSwapError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { error?: string; message?: string }
  return e.error === 'InvalidSwap' || /invalidswap/i.test(e.message ?? '')
}

// Duplicated from profile.ts / follow.ts — small, and not worth a shared module.
function isRecordNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: number; error?: string; message?: string }
  if (e.error === 'RecordNotFound') return true
  if (
    e.status === 400 &&
    typeof e.message === 'string' &&
    /could not locate|not found|recordnotfound/i.test(e.message)
  ) {
    return true
  }
  return false
}
