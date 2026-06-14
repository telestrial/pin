import type { UploadTask } from '../stores/uploadQueue'

// Dedicated IndexedDB for the upload queue so a tab close mid-upload doesn't
// drop the pending bytes — the queue resumes on the next load. Separate from
// the item cache's DB (lib/itemCache.ts) so the two version their schemas
// independently. Tasks (including their Uint8Array body + attachment bytes)
// round-trip through structured clone unchanged.
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

// Write a task snapshot. Fire-and-forget — callers don't await, and any
// failure (no IDB, quota, serialization) is swallowed so persistence can
// never break the in-memory queue. Only ever called with 'pending' or
// 'failed' tasks (see the store): in-flight states are deliberately not
// persisted, so an interrupted run rehydrates as 'pending' and re-runs.
export async function persistTask(task: UploadTask): Promise<void> {
  if (!available()) return
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(task)
    await txDone(tx)
  } catch {
    // best-effort
  }
}

export async function deletePersistedTask(id: string): Promise<void> {
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

export async function clearPersistedTasks(): Promise<void> {
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

export async function loadPersistedTasks(): Promise<UploadTask[]> {
  if (!available()) return []
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readonly')
    const all = (await reqAsPromise(
      tx.objectStore(STORE).getAll(),
    )) as UploadTask[]
    await txDone(tx)
    return all
  } catch {
    return []
  }
}
