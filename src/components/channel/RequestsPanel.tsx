import { useState } from 'react'
import { channelKeyFromBase64 } from '../../core/crypto'
import type { InboxRequest } from '../../core/requests'
import { approveRequest, denyRequest } from '../../lib/access'
import { useAuthStore } from '../../stores/auth'
import { useToastStore } from '../../stores/toast'
import { PersonRow } from '../PersonRow'

/** The people asking to read one of your private channels, and your answer to each.
 *
 *  Approving seats them, and their invitation travels as any other does — their own Curator
 *  takes it and, since they asked, joins on its own. Denying tells them, and only them; they
 *  may ask again once they have withdrawn. Nothing about a request or its answer is public. */
export function RequestsPanel({
  channelID,
  channelKey,
  pending,
  onHandleClick,
}: {
  channelID: string
  /** K, base64, as the owned channel stores it. */
  channelKey: string
  pending: InboxRequest[]
  onHandleClick: (handle: string) => void
}) {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const addToast = useToastStore((s) => s.addToast)
  const [answering, setAnswering] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  async function answer(did: string, approve: boolean) {
    if (!storedKeyHex) return
    setProblem(null)
    setAnswering(did)
    try {
      if (approve) {
        await approveRequest(
          storedKeyHex,
          channelKeyFromBase64(channelKey),
          did,
        )
        addToast('Approved')
      } else {
        await denyRequest(storedKeyHex, channelID, did)
        addToast('Not approved')
      }
    } catch (err) {
      setProblem(`Couldn’t answer: ${String(err)}`)
    } finally {
      setAnswering(null)
    }
  }

  return (
    <section aria-label="Requests" className="space-y-2">
      <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wide px-1">
        Requests
      </h2>
      {problem && <p className="text-xs text-red-600 px-1">{problem}</p>}
      {pending.length === 0 ? (
        <p className="text-xs text-neutral-500 px-1">Nobody is waiting.</p>
      ) : (
        <div className="bg-white border border-neutral-200 rounded-lg divide-y divide-neutral-100">
          {pending.map((r) => (
            <PersonRow
              key={r.actor}
              didDht={r.actor}
              onHandleClick={onHandleClick}
              action={
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void answer(r.actor, true)}
                    disabled={answering !== null}
                    className="px-2.5 py-1 text-xs font-medium text-white bg-neutral-900 hover:bg-neutral-700 rounded-md transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {answering === r.actor ? 'Answering…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void answer(r.actor, false)}
                    disabled={answering !== null}
                    className="px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    Deny
                  </button>
                </div>
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}
