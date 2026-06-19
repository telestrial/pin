import type { Action } from '../stores/actionQueue'

// Dedicated IndexedDB for the action journal so a tab close mid-action doesn't
// drop pending work — the journal resumes on the next load. Separate from the
// item cache's DB (lib/itemCache.ts) so the two version their schemas
// independently. Actions (including any Uint8Array body + attachment bytes a
// publish carries) round-trip through structured clone unchanged.
//
// The DB name is unchanged from the upload-queue era on purpose: an in-flight
// record persisted by an older build shouldn't be orphaned across the rename.
// Old records have no `kind`, so hydration (useActionRunner) filters them out.
const DB_NAME = 'pin-upload-queue'
const DB_VERSION = 1
const STORE = 'tasks'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
  })
  return dbPromise
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function available(): boolean {
  return typeof indexedDB !== 'undefined'
}

// Write an action snapshot. Fire-and-forget — callers don't await, and any
// failure (no IDB, quota, serialization) is swallowed so persistence can never
// break the in-memory journal. Only ever called with 'pending' or 'failed'
// snapshots (see the store): in-flight states aren't persisted, so an
// interrupted run rehydrates as 'pending' and re-runs.
export async function persistAction(action: Action): Promise<void> {
  if (!available()) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(action)
    await txDone(tx)
  } catch {
    // best-effort
  }
}

export async function deletePersistedAction(id: string): Promise<void> {
  if (!available()) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    await txDone(tx)
  } catch {
    // best-effort
  }
}

export async function clearPersistedActions(): Promise<void> {
  if (!available()) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await txDone(tx)
  } catch {
    // best-effort
  }
}

// Loads every persisted record. The caller (hydration) is responsible for
// filtering to recognized kinds — records written by an older build have no
// recognized `kind` and a different shape.
export async function loadPersistedActions(): Promise<Action[]> {
  if (!available()) return []
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readonly')
    const all = (await reqAsPromise(
      tx.objectStore(STORE).getAll(),
    )) as Action[]
    await txDone(tx)
    return all
  } catch {
    return []
  }
}
