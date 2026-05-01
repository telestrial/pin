import { Pin } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Builder } from '@siafoundation/sia-storage'
import { useAuthStore } from '../../stores/auth'

export function ApproveScreen({
  builder,
}: {
  builder: React.RefObject<Builder | null>
}) {
  const { approvalURL, setStep, setError } = useAuthStore()
  const [polling, setPolling] = useState(true)
  const [pollError, setPollError] = useState(false)
  const [manualChecking, setManualChecking] = useState(false)
  const pollStarted = useRef(false)

  useEffect(() => {
    // Guard against React strict mode double-mount — waitForApproval()
    // consumes the builder's state and cannot be called twice.
    if (pollStarted.current) return
    pollStarted.current = true

    async function poll() {
      const b = builder.current
      if (!b) return

      try {
        await b.waitForApproval()
        setStep('recovery')
      } catch {
        setPolling(false)
        setPollError(true)
      }
    }

    poll()
  }, [builder, setStep])

  async function handleManualCheck() {
    const b = builder.current
    if (!b) {
      setError('No builder instance')
      return
    }

    setManualChecking(true)
    setPollError(false)
    setPolling(true)
    try {
      await b.waitForApproval()
      setStep('recovery')
    } catch (e) {
      setPolling(false)
      setPollError(true)
      setError(e instanceof Error ? e.message : 'Approval check failed')
    } finally {
      setManualChecking(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-green-50 border border-green-100">
            <Pin className="size-7 text-green-600" fill="currentColor" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">
              Approve Pin at sia.storage
            </h1>
            <p className="text-neutral-600 text-sm leading-relaxed">
              Open the link below, approve Pin to use your storage account,
              then come back here.
            </p>
          </div>
        </div>

        {approvalURL && (
          <div className="space-y-3">
            <a
              href={approvalURL}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
            >
              Open approval page →
            </a>
            <button
              type="button"
              onClick={handleManualCheck}
              disabled={manualChecking}
              className="w-full py-2 text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
            >
              {manualChecking ? 'Checking…' : "I've approved — continue"}
            </button>
          </div>
        )}

        <div className="flex items-center justify-center gap-2 text-xs text-neutral-500">
          {polling ? (
            <>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-600" />
              </span>
              Waiting for approval…
            </>
          ) : pollError ? (
            <span>Auto-check stopped — use the button above</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
