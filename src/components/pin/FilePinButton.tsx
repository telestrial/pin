import { useState } from 'react'
import { removeAttachmentFromItem } from '../../core/channels'
import type { AttachmentRef } from '../../core/types'
import { itemRefFromAttachment } from '../../lib/filePin'
import { formatBytes } from '../../lib/format'
import { LIBRARY_CHANNEL } from '../../lib/pinUpload'
import { objectIDsInManifests } from '../../lib/scopeRefs'
import { useActionStore } from '../../stores/actionQueue'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { objectIDsReferencedBy, usePinStore } from '../../stores/pin'
import { useToastStore } from '../../stores/toast'
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
      const { orphanedObjectIDs } = await removeAttachmentFromItem(
        agent,
        ownedChannel,
        itemID,
        attachment.url,
        protectedIDs,
      )
      // Record write done; reclaim the file's bytes via the journal.
      useActionStore.getState().enqueueDeleteObjects({
        objectIDs: orphanedObjectIDs,
        label: `Reclaiming ${attachment.filename || 'file'}`,
      })
      const sub = subscriptions.find(
        (s) => s.channelID === ownedChannel.channelID,
      )
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

  // Attachment pins are invisible at rest and minimal: the whole pill — bg,
  // shadow, icon — appears (quickly) only when the cursor is essentially on the
  // button itself (opacity-0 + hover:opacity-100; an opacity-0 element still
  // captures pointer events), and disappears just as fast when you leave.
  // Once visible, the color follows the same ownership axis as the post
  // PinButton: green = "you own it", light green = "click to own it".
  //  owned / library-pinned → owned green; brightens within the owned family on
  //                           direct hover (click retracts the file / releases
  //                           the library pin)
  //  pinnable               → light green; brightens on hover (click mirrors the
  //                           file to your library)
  const stateAndClass =
    isOwned || isPinned
      ? ({
          state: 'pinned',
          cls: 'text-green-700 hover:text-green-600',
        } as const)
      : ({
          state: 'pinnable',
          cls: 'text-green-400 hover:text-green-500',
        } as const)

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || !sdk}
      title={title}
      aria-label={title}
      aria-pressed={!isOwned && isPinned}
      className={`absolute top-1.5 right-1.5 p-1 rounded-full bg-white/80 backdrop-blur-sm shadow-sm cursor-pointer opacity-0 hover:opacity-100 focus:opacity-100 transition-all duration-150 disabled:cursor-default disabled:opacity-50 ${stateAndClass.cls}`}
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
