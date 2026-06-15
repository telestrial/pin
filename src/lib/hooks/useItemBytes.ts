import { useEffect, useState } from 'react'
import { downloadItemBytes } from '../../core/channels'
import { useAuthStore } from '../../stores/auth'
import { getCached, putCached } from '../itemCache'

// Cache key for an item: prefer the plaintext content hash when present
// (stable across repack URL swaps and across encryption regimes), fall
// back to the itemURL for legacy items that don't carry a hash yet.
function cacheKey(itemURL: string, contentHash: string | undefined): string {
  return contentHash ?? itemURL
}

const memCache = new Map<string, Uint8Array>()

export function useItemBytes(itemURL: string, contentHash?: string) {
  const sdk = useAuthStore((s) => s.sdk)
  const key = cacheKey(itemURL, contentHash)
  const [bytes, setBytes] = useState<Uint8Array | null>(
    () => memCache.get(key) ?? null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sdk) return

    const mem = memCache.get(key)
    if (mem) {
      setBytes(mem)
      setError(null)
      return
    }

    let cancelled = false
    setBytes(null)
    setError(null)

    ;(async () => {
      try {
        const cached = await getCached(key)
        if (cancelled) return
        if (cached) {
          const buf = await cached.arrayBuffer()
          if (cancelled) return
          const arr = new Uint8Array(buf)
          memCache.set(key, arr)
          setBytes(arr)
          return
        }
        const fetched = await downloadItemBytes(sdk, itemURL)
        if (cancelled) return
        memCache.set(key, fetched)
        setBytes(fetched)
        putCached(key, new Blob([fetched as BlobPart])).catch(() => {})
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sdk, key, itemURL])

  return { bytes, error }
}

export function useItemBlobURL(
  itemURL: string,
  mimeType: string,
  contentHash?: string,
) {
  const { bytes, error } = useItemBytes(itemURL, contentHash)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!bytes) return
    const blob = new Blob([bytes as BlobPart], { type: mimeType })
    const blobURL = URL.createObjectURL(blob)
    setUrl(blobURL)
    return () => {
      URL.revokeObjectURL(blobURL)
    }
  }, [bytes, mimeType])

  return { url, error }
}
