import { useRef, useState } from 'react'
import { useAuthStore } from '../../stores/auth'
import { usePinStore } from '../../stores/pin'
import { useToastStore } from '../../stores/toast'

const DEFAULT_FADE_MS = 1500

// Click-to-unpin with cancel-during-fade. The row/tile fades over
// `fadeMs`, then the unpin commits. A second click during the fade
// cancels the timeout and removes the URL from `removingURLs`, so the
// caller can restore opacity. On unpin failure the URL is also pulled
// out of the set, giving the user a chance to retry.
export function useFadeCancelUnpin(opts?: { fadeMs?: number }) {
  const sdk = useAuthStore((s) => s.sdk)
  const unpin = usePinStore((s) => s.unpin)
  const addToast = useToastStore((s) => s.addToast)

  const fadeMs = opts?.fadeMs ?? DEFAULT_FADE_MS

  const [removingURLs, setRemovingURLs] = useState<Set<string>>(() => new Set())
  const removeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  )

  function startRemove(url: string) {
    setRemovingURLs((prev) => {
      const next = new Set(prev)
      next.add(url)
      return next
    })
    const id = setTimeout(async () => {
      removeTimers.current.delete(url)
      if (!sdk) return
      try {
        await unpin(sdk, url)
      } catch (err) {
        // Restore opacity on failure so the user can retry.
        setRemovingURLs((prev) => {
          const next = new Set(prev)
          next.delete(url)
          return next
        })
        addToast(err instanceof Error ? err.message : 'Unpin failed')
      }
    }, fadeMs)
    removeTimers.current.set(url, id)
  }

  function cancelRemove(url: string) {
    const id = removeTimers.current.get(url)
    if (id !== undefined) {
      clearTimeout(id)
      removeTimers.current.delete(url)
    }
    setRemovingURLs((prev) => {
      const next = new Set(prev)
      next.delete(url)
      return next
    })
  }

  function toggle(url: string) {
    if (removingURLs.has(url)) cancelRemove(url)
    else startRemove(url)
  }

  return { removingURLs, startRemove, cancelRemove, toggle }
}
