import { useEffect, useState } from 'react'
import { downloadItemBytes } from '../core/channels'
import { useAuthStore } from '../stores/auth'
import { getCached, putCached } from './itemCache'

const memCache = new Map<string, Uint8Array>()

export function useItemBytes(itemURL: string) {
  const sdk = useAuthStore((s) => s.sdk)
  const [bytes, setBytes] = useState<Uint8Array | null>(() => memCache.get(itemURL) ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sdk) return

    const mem = memCache.get(itemURL)
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
        const cached = await getCached(itemURL)
        if (cancelled) return
        if (cached) {
          const buf = await cached.arrayBuffer()
          if (cancelled) return
          const arr = new Uint8Array(buf)
          memCache.set(itemURL, arr)
          setBytes(arr)
          return
        }
        const fetched = await downloadItemBytes(sdk, itemURL)
        if (cancelled) return
        memCache.set(itemURL, fetched)
        setBytes(fetched)
        putCached(itemURL, new Blob([fetched as BlobPart])).catch(() => {})
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sdk, itemURL])

  return { bytes, error }
}

export function useItemBlobURL(itemURL: string, mimeType: string) {
  const { bytes, error } = useItemBytes(itemURL)
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
