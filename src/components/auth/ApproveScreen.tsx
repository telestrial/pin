import { useEffect, useRef, useState } from 'react'
import { inTauri, openExternal } from '../../lib/openExternal'
import { waitForSiaApproval } from '../../lib/siaAuth'
import { useAuthStore } from '../../stores/auth'

export function ApproveScreen() {
  const { approvalURL, setStep } = useAuthStore()
  const [polling, setPolling] = useState(true)
  const [expired, setExpired] = useState(false)
  const pollStarted = useRef(false)

  useEffect(() => {
    // Load-bearing, not belt-and-braces: React mounts effects twice in strict
    // mode, and the second call would find the pending request already taken by
    // the first and report that as a failure while the first is still
    // legitimately waiting.
    if (pollStarted.current) return
    pollStarted.current = true

    // One call that polls until approval or expiry, so there is nothing to
    // re-drive on a timer. A failure can't be retried in place — the attempt
    // consumes the pending request — so starting over is the only way back.
    waitForSiaApproval()
      .then(() => setStep('recovery'))
      .catch(() => {
        setPolling(false)
        setExpired(true)
      })
  }, [setStep])

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">
          Approve Pin at sia.storage
        </h1>
        <p className="text-neutral-600 text-sm leading-relaxed">
          Open the link below, approve Pin to use your storage account, then
          come back here.
        </p>
      </div>

      {approvalURL && !expired && (
        <a
          href={approvalURL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            // In the desktop shell the webview won't pop a new window;
            // route to the system browser instead. Web path is unchanged.
            if (inTauri()) {
              e.preventDefault()
              void openExternal(approvalURL)
            }
          }}
          className="block w-full text-center py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
        >
          Open approval page →
        </a>
      )}

      {expired && (
        <div className="space-y-2">
          <p className="text-center text-sm text-neutral-600">
            This approval request is no longer valid. Start over to get a fresh
            link.
          </p>
          <button
            type="button"
            onClick={() => setStep('welcome')}
            className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
          >
            Start over
          </button>
        </div>
      )}

      {polling && (
        <div className="flex items-center justify-center gap-2 text-xs text-neutral-500">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-600" />
          </span>
          Waiting for approval…
        </div>
      )}
    </div>
  )
}
