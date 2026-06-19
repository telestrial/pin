// Full-account wipe primitives, used by the Settings → Full reset button.
// These are the destructive inverse of everything else: delete every Sia
// object in scope and every Pin record under the user's repo. The caller
// (the Settings view) runs them while sdk + agent are still alive, then clears
// local storage and reloads to the login screen.

import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { CHANNEL_LEXICON } from './atproto'
import { SUBSCRIPTION_LEXICON } from './follow'
import { HANDLEFOLLOW_LEXICON } from './handleFollow'
import { PROFILE_LEXICON } from './profile'
import { SETTINGS_LEXICON } from './settingsRecord'

const PAGE_LIMIT = 200
// Generous cap for a wipe — 200 × 100 = 20000 covers any realistic account.
const MAX_PAGES = 100

// Every atproto collection Pin writes to. A full reset clears all of them.
export const PIN_LEXICONS = [
  CHANNEL_LEXICON,
  PROFILE_LEXICON,
  SUBSCRIPTION_LEXICON,
  HANDLEFOLLOW_LEXICON,
  SETTINGS_LEXICON,
] as const

export type WipeResult = { deleted: number; failed: number }

// Delete every pinned object in the user's Sia scope, then prune the emptied
// slabs. Deletes are idempotent (already-gone counts as success) and get one
// retry pass so a QUIC blip doesn't strand objects. Returns counts.
export async function wipeAllSiaObjects(sdk: Sdk): Promise<WipeResult> {
  // Current pinned set = latest event per id that isn't a delete. Same walk
  // shape as fetchRawContentBytes (structured `{id, after}` cursor).
  // biome-ignore lint/suspicious/noExplicitAny: SDK ObjectEvent / cursor types aren't exported
  const latestByID = new Map<string, any>()
  // biome-ignore lint/suspicious/noExplicitAny: SDK cursor type isn't exported
  let cursor: any = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const events = await sdk.objectEvents(cursor, PAGE_LIMIT)
    if (events.length === 0) break
    for (const ev of events) {
      const prev = latestByID.get(ev.id)
      if (!prev || ev.updatedAt > prev.updatedAt) latestByID.set(ev.id, ev)
    }
    if (events.length < PAGE_LIMIT) break
    const last = events[events.length - 1]
    cursor = { id: last.id, after: last.updatedAt }
  }
  const ids: string[] = []
  for (const [id, ev] of latestByID) if (!ev.deleted) ids.push(id)

  let deleted = 0
  let remaining = ids
  for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt++) {
    const stillFailing: string[] = []
    for (const id of remaining) {
      try {
        await sdk.deleteObject(id)
        deleted++
      } catch (e) {
        if (isNotFound(e)) {
          deleted++ // already gone = success
          continue
        }
        stillFailing.push(id)
      }
    }
    remaining = stillFailing
  }

  await sdk.pruneSlabs().catch(() => {})
  return { deleted, failed: remaining.length }
}

// Delete every Pin record under the user's repo across all five lexicons.
export async function wipeAllPinRecords(agent: Agent): Promise<WipeResult> {
  const did = agent.assertDid
  let deleted = 0
  let failed = 0

  for (const collection of PIN_LEXICONS) {
    const rkeys: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await agent.com.atproto.repo.listRecords({
        repo: did,
        collection,
        limit: PAGE_LIMIT,
        cursor,
      })
      for (const rec of res.data.records) {
        const rkey = rec.uri.split('/').pop()
        if (rkey) rkeys.push(rkey)
      }
      cursor = res.data.cursor
      if (!cursor || res.data.records.length === 0) break
    }

    for (const rkey of rkeys) {
      try {
        await agent.com.atproto.repo.deleteRecord({ repo: did, collection, rkey })
        deleted++
      } catch (e) {
        if (isRecordNotFound(e)) {
          deleted++
          continue
        }
        failed++
      }
    }
  }

  return { deleted, failed }
}

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /not found|could not locate|does not exist|no such object/i.test(msg)
}

function isRecordNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: number; error?: string; message?: string }
  if (e.error === 'RecordNotFound') return true
  return (
    e.status === 400 &&
    typeof e.message === 'string' &&
    /could not locate|not found|recordnotfound/i.test(e.message)
  )
}
