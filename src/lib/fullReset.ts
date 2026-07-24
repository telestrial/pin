import { wipeAllSiaObjects } from '../core/reset'
import type { SiaClient } from '../core/siaClient'

// Nuke everything and reload to the login screen. Order matters: do the Sia
// wipe while the client is still alive, then clear all local storage and reload —
// a fresh boot with nothing persisted lands the user at the welcome screen.
// (did:dht/pkarr records aren't deleted; they expire by TTL.)
//
// Best-effort throughout: a failed leg is logged but never blocks the rest, so
// the reset always reaches "logged out at welcome." (A QUIC failure mid Sia
// wipe can strand a few objects; re-running the reset finishes them.)
export async function fullReset(opts: {
  client: SiaClient | null
}): Promise<void> {
  const { client } = opts

  if (client) {
    try {
      console.log('full reset: objects', await wipeAllSiaObjects(client))
    } catch (e) {
      console.warn('full reset: object wipe failed', e)
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

// Delete every IndexedDB database — item cache, action journal, etc.
// Chrome (our dev/test target) supports indexedDB.databases().
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
