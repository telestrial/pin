const DB_NAME = 'pin-cache'
const DB_VERSION = 1
const STORE = 'items'
const HARD_CAP_BYTES = 500 * 1024 * 1024
const QUOTA_FRACTION = 0.25

type Entry = {
  url: string
  blob: Blob
  byteSize: number
  lastAccessed: number
}

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
        const store = db.createObjectStore(STORE, { keyPath: 'url' })
        store.createIndex('lastAccessed', 'lastAccessed')
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

export async function getCached(url: string): Promise<Blob | null> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const entry = (await reqAsPromise(store.get(url))) as Entry | undefined
    if (!entry) {
      await txDone(tx)
      return null
    }
    entry.lastAccessed = Date.now()
    store.put(entry)
    await txDone(tx)
    return entry.blob
  } catch {
    return null
  }
}

export async function putCached(url: string, blob: Blob): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const entry: Entry = {
      url,
      blob,
      byteSize: blob.size,
      lastAccessed: Date.now(),
    }
    store.put(entry)
    await txDone(tx)
    await evictIfNeeded()
  } catch {
    // best-effort; cache failures must not break reads
  }
}

async function computeCap(): Promise<number> {
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const { quota } = await navigator.storage.estimate()
      if (quota) {
        return Math.min(HARD_CAP_BYTES, Math.floor(quota * QUOTA_FRACTION))
      }
    } catch {
      // fall through to hard cap
    }
  }
  return HARD_CAP_BYTES
}

async function evictIfNeeded(): Promise<void> {
  const cap = await computeCap()
  const db = await openDB()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const idx = store.index('lastAccessed')

  let total = 0
  await new Promise<void>((resolve, reject) => {
    const r = store.openCursor()
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const c = r.result
      if (!c) return resolve()
      total += (c.value as Entry).byteSize
      c.continue()
    }
  })

  if (total <= cap) {
    await txDone(tx)
    return
  }

  await new Promise<void>((resolve, reject) => {
    const r = idx.openCursor()
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const c = r.result
      if (!c || total <= cap) return resolve()
      total -= (c.value as Entry).byteSize
      c.delete()
      c.continue()
    }
  })

  await txDone(tx)
}
