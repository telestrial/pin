import { useState } from 'react'
import { channelKeyFromBase64 } from '../../core/crypto'
import { readDirectory } from '../../lib/directories'
import { useMembers } from '../../lib/hooks/useMembers'
import { inviteMember, removeMember } from '../../lib/members'
import { useAuthStore } from '../../stores/auth'
import { useToastStore } from '../../stores/toast'
import { NetworkSearch } from '../NetworkSearch'
import { PersonRow } from '../PersonRow'

/** Who can read one of your Secret channels, and the two things you can do about it.
 *
 *  An invitation is sealed to the person's encryption key, which their directory
 *  publishes — so the people offered are the ones the Curator has read, and somebody whose
 *  directory carries no key cannot be invited until it does. Removing somebody moves the
 *  channel to a new key they do not get; what they already fetched stays theirs. */
export function MembersPanel({
  channelID,
  channelKey,
  onHandleClick,
}: {
  channelID: string
  /** K, base64, as the owned channel stores it. */
  channelKey: string
  onHandleClick: (handle: string) => void
}) {
  const storedKeyHex = useAuthStore((s) => s.storedKeyHex)
  const myDidDht = useAuthStore((s) => s.myDidDht)
  const addToast = useToastStore((s) => s.addToast)
  const members = useMembers(channelID)
  const [inviting, setInviting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  async function invite(did: string) {
    setProblem(null)
    if (!storedKeyHex) return
    if (did === myDidDht) {
      setProblem('That’s you — you can already read your own channel.')
      return
    }
    if (members?.some((m) => m.did === did)) {
      setProblem('Already a member.')
      return
    }
    setInviting(true)
    try {
      const record = await readDirectory(storedKeyHex, did)
      if (!record?.encKey) {
        setProblem(
          'They haven’t published an encryption key yet, so an invitation can’t be sealed to them.',
        )
        return
      }
      await inviteMember(
        storedKeyHex,
        channelKeyFromBase64(channelKey),
        did,
        record.encKey,
      )
      addToast('Invited')
    } catch (err) {
      setProblem(`Couldn’t invite: ${String(err)}`)
    } finally {
      setInviting(false)
    }
  }

  async function remove(did: string) {
    setProblem(null)
    setRemoving(did)
    try {
      await removeMember(channelID, did)
    } catch (err) {
      setProblem(`Couldn’t remove: ${String(err)}`)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <section aria-label="Members" className="space-y-2">
      <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wide px-1">
        Members
      </h2>
      <div className="bg-white border border-neutral-200 rounded-lg p-3 space-y-2">
        <NetworkSearch
          onPerson={(did) => void invite(did)}
          placeholder={inviting ? 'Inviting…' : 'Invite someone you know of'}
        />
        {problem && <p className="text-xs text-red-600 px-1">{problem}</p>}
      </div>
      {members === null ? null : members.length === 0 ? (
        <p className="text-xs text-neutral-500 px-1">
          No members yet. Only the people you invite can read this channel.
        </p>
      ) : (
        <div className="bg-white border border-neutral-200 rounded-lg divide-y divide-neutral-100">
          {members.map((m) => (
            <PersonRow
              key={m.did}
              didDht={m.did}
              onHandleClick={onHandleClick}
              action={
                <button
                  type="button"
                  onClick={() => void remove(m.did)}
                  disabled={removing !== null}
                  className="px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {removing === m.did ? 'Removing…' : 'Remove'}
                </button>
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}
