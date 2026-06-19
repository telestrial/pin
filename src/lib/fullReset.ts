import type { Agent } from '@atproto/api'
import type { Sdk } from '@siafoundation/sia-storage'
import { wipeAllPinRecords, wipeAllSiaObjects } from '../core/reset'
import { signOutOauth } from './atprotoClient'

// Nuke everything and reload to the login screen. Order matters: do the network
// deletes while sdk + agent are still alive, sign out of atproto so the reload
// doesn't half-restore, then clear all local storage and reload — a fresh boot
// with nothing persisted lands the user at the welcome screen.
//
// Best-effort throughout: a failed leg is logged but never blocks the rest, so
// the reset always reaches "logged out at welcome." (A QUIC failure mid Sia
// wipe can strand a few objects; re-running the reset finishes them.)
export async function fullReset(opts: {
  sdk: Sdk | null
  agent: Agent | null
  atprotoDID: string | null
}): Promise<void> {
  const { sdk, agent, atprotoDID } = opts

  if (agent) {
    try {
      console.log('full reset: records', await wipeAllPinRecords(agent))
    } catch (e) {
      console.warn('full reset: record wipe failed', e)
    }
  }
  if (sdk) {
    try {
      console.log('full reset: objects', await wipeAllSiaObjects(sdk))
    } catch (e) {
      console.warn('full reset: object wipe failed', e)
    }
  }
  if (atprotoDID) {
    try {
      await signOutOauth(atprotoDID)
    } catch (e) {
      console.warn('full reset: oauth revoke failed', e)
    }
  }

  try {
    localStorage.clear()
  } catch {}
  try {
    sessionStorage.clear()
  } catch {}
  await clearAllIndexedDB()

  location.reload()
}

// Delete every IndexedDB database — item cache, action journal, and the OAuth
// session store. Chrome (our dev/test target) supports indexedDB.databases().
// A delete blocked by an open connection just resolves; the reload tears the
// connections down regardless.
async function clearAllIndexedDB(): Promise<void> {
  try {
    const dbs = (await indexedDB.databases()) ?? []
    await Promise.all(
      dbs.map((d) => (d.name ? deleteDB(d.name) : Promise.resolve())),
    )
  } catch (e) {
    console.warn('full reset: IndexedDB clear failed', e)
  }
}

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}
