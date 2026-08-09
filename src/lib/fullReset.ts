import { wipeAllSiaObjects } from '../core/reset'
import type { SiaClient } from '../core/siaClient'
import { inTauri } from './openExternal'

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

  // The Curator's replica lives outside the webview, so none of the clearing below
  // reaches it. Left in place, restoring the same recovery phrase reopens the same
  // namespace with the old records still there — channels that no longer exist, and
  // publish pointers naming Sia objects this reset has just deleted — which then ride
  // along in every new snapshot. Do it AFTER the Sia wipe, which needs a live client,
  // and BEFORE the reload, which would otherwise restart the Curator on the old store.
  await resetCuratorStore()

  try {
    localStorage.clear()
  } catch {}
  try {
    sessionStorage.clear()
  } catch {}
  await clearAllIndexedDB()

  location.reload()
}

// Stop the Curator and delete its on-disk store. Desktop only — on web there's no
// native process, and the doc lives in memory that the reload clears anyway. The
// import is dynamic so @tauri-apps/api never enters the web bundle.
async function resetCuratorStore(): Promise<void> {
  if (!inTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('curator_reset')
    console.log('full reset: curator store cleared')
  } catch (e) {
    console.warn('full reset: curator store clear failed', e)
  }
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
