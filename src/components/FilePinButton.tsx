import { useState } from 'react'
import { removeAttachmentFromItem } from '../core/channels'
import type { AttachmentRef } from '../core/types'
import { itemRefFromAttachment } from '../lib/filePin'
import { formatBytes } from '../lib/format'
import { LIBRARY_CHANNEL } from '../lib/pinUpload'
import { objectIDsInManifests } from '../lib/scopeRefs'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { objectIDsReferencedBy, usePinStore } from '../stores/pin'
import { useToastStore } from '../stores/toast'
import { PinIcon } from './PinIcon'

// Per-file pin affordance on a post attachment tile. Forks on ownership, the
// same way the post-level PinButton does:
//
//   You own the post      → filled green (you host these bytes). Click retracts
//                            just this file: rewrite the manifest entry without
//                            it + delete its bytes (reference-safe, eager). The
//                            file-level analog of retracting the whole post.
//   You don't own the post → mirror this one file into your Library as a
//                            standalone item (a custody relationship separate
//                            from a whole-post pin). Click again to release.
//
// Standalone-library-pin state keys on attachment.url — true only for a library
// pin (a whole-post pin stores attachment URLs inside item.attachments, never
// as a pin's itemURL), so it never aliases the post pin.
export function FilePinButton({
  attachment,
  channelID,
  itemID,
}: {
  attachment: AttachmentRef
  channelID: string
  itemID: string
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAuthStore((s) => s.atprotoAgent)
  const ownedChannel = useAuthStore((s) =>
    s.myChannels.find((c) => c.channelID === channelID),
  )
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const isPinned = usePinStore((s) => s.isPinned(attachment.url))
  const isPinning = usePinStore((s) => s.isPinning(attachment.url))
  const pin = usePinStore((s) => s.pin)
  const unpin = usePinStore((s) => s.unpin)
  const addToast = useToastStore((s) => s.addToast)
  const refreshChannel = useFeedStore((s) => s.refreshChannel)

  const [removing, setRemoving] = useState(false)
  const isOwned = !!ownedChannel
  const busy = isPinning || removing

  const retractFile = async () => {
    if (!sdk || !ownedChannel || !agent) return
    const ok = window.confirm(
      'Remove this file from the post? Subscribers who pinned it keep their copies.',
    )
    if (!ok) return
    setRemoving(true)
    try {
      // Reference-safe eager cleanup: protect bytes still referenced by your
      // other channels' manifests or any pin (both read from memory here).
      const protectedIDs = new Set([
        ...objectIDsInManifests(
          useFeedStore.getState().manifests,
          ownedChannel.channelID,
        ),
        ...objectIDsReferencedBy(usePinStore.getState().pinned),
      ])
      await removeAttachmentFromItem(
        sdk,
        agent,
        ownedChannel,
        itemID,
        attachment.url,
        protectedIDs,
      )
      const sub = subscriptions.find((s) => s.channelID === ownedChannel.channelID)
      if (sub) await refreshChannel(sub)
      usePinStore.getState().refreshAccount(sdk)
      addToast('File removed from the post')
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setRemoving(false)
    }
  }

  const toggleLibraryPin = async () => {
    if (!sdk) return
    try {
      if (isPinned) {
        await unpin(sdk, attachment.url)
        addToast('File removed from your library')
      } else {
        await pin(sdk, {
          item: itemRefFromAttachment(attachment),
          channel: LIBRARY_CHANNEL,
        })
        addToast('File pinned to your library')
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Pin failed')
    }
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!sdk || busy) return
    if (isOwned) {
      void retractFile()
    } else {
      void toggleLibraryPin()
    }
  }

  const size = formatBytes(attachment.byteSize)
  const title = isOwned
    ? `Remove this file from the post (${size})`
    : isPinned
      ? `Remove this file from your library (${size})`
      : `Pin this file to your library (${size})`

  // One uniform pattern across every attachment type:
  //  owned          → dim green pin at rest (you barely register you own it),
  //                   full green on hover (click retracts the file)
  //  library-pinned → solid green, always visible (deliberate "I keep this";
  //                   click releases)
  //  pinnable       → solid, opaque outline at rest, ready for pinning; greens
  //                   on hover (click mirrors the file to your library)
  const stateAndClass = isOwned
    ? ({
        state: 'pinned',
        cls: 'text-green-600 hover:text-green-700 opacity-40 group-hover:opacity-100 focus:opacity-100',
      } as const)
    : isPinned
      ? ({
          state: 'pinned',
          cls: 'text-green-600 hover:text-green-700',
        } as const)
      : ({
          state: 'pinnable',
          cls: 'text-neutral-600 hover:text-green-600',
        } as const)

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || !sdk}
      title={title}
      aria-label={title}
      aria-pressed={!isOwned && isPinned}
      className={`absolute top-1.5 right-1.5 p-1 rounded-full bg-white/80 backdrop-blur-sm shadow-sm transition-opacity disabled:opacity-50 ${stateAndClass.cls}`}
    >
      {busy ? (
        <span className="block size-6">
          <span className="block size-6 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin" />
        </span>
      ) : (
        <PinIcon state={stateAndClass.state} aria-hidden="true" />
      )}
    </button>
  )
}
