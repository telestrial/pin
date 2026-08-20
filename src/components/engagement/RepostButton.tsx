import { Check, Recycle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { portalKey } from '../../core/feed'
import type { RepostRef } from '../../core/types'
import { repostInChannel, unrepostFromChannel } from '../../lib/channelWrites'
import type { PortalTarget } from '../../lib/repost'
import { useAuthStore } from '../../stores/auth'
import { useFeedStore } from '../../stores/feed'
import { useToastStore } from '../../stores/toast'
import { ChannelAvatar } from '../channel/ChannelAvatar'

// Circulating somebody else's post in one of your own channels.
//
// A multi-select rather than a single act, because a Pin identity speaks as several
// channels and "which voice is circulating this" is a real question with more than one
// answer. Closest thing anywhere else is Tumblr's reblog-to-which-blog picker — except
// this makes a REFERENCE where Tumblr makes a copy, so the post stays the author's and
// stays revocable by them.
//
// Each checkmark is a genuine publish: a new Sia object for the channel's manifest and a
// new DHT pointer. So a toggle spins while it lands and says so when it doesn't — unlike
// a like, which is a local record a background loop delivers later.

/** The channels this identity could circulate a post through, and which already do. */
function useOwnChannels(target: PortalTarget | null) {
  const myChannels = useAuthStore((s) => s.myChannels)
  const manifests = useFeedStore((s) => s.manifests)

  const key = target ? portalKey(target) : ''
  return myChannels
    .filter((c) => c.channelID !== target?.channelID)
    .map((c) => {
      const manifest = manifests[c.channelID]
      return {
        channelID: c.channelID,
        channelKey: c.channelKey,
        name: manifest?.name ?? c.name,
        avatar: manifest?.avatar,
        // Absent manifest reads as "not carrying it", which is the safe direction: the
        // worst case is a channel that already has it offering to add it again, and the
        // transform is idempotent, so a repeat is a no-op.
        carries: (manifest?.reposts ?? []).some((r) => portalKey(r) === key),
      }
    })
}

export function RepostButton({
  target,
  sourceName,
}: {
  /** The post to circulate, or null when it cannot be — see `useRepostTarget`. */
  target: PortalTarget | null
  /** The source channel's name, cached on the portal so a row renders before it
   *  resolves. */
  sourceName?: string
}) {
  const client = useAuthStore((s) => s.client)
  const addToast = useToastStore((s) => s.addToast)
  const channels = useOwnChannels(target)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const wrapper = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Nothing to point at, or nowhere to point it from.
  if (!target || !client || channels.length === 0) return null

  const carrying = channels.filter((c) => c.carries).length

  const toggle = async (c: (typeof channels)[number]) => {
    if (busy) return
    setBusy(c.channelID)
    try {
      if (c.carries) {
        await unrepostFromChannel(client, c, target)
      } else {
        const repost: RepostRef = {
          ...target,
          repostedAt: new Date().toISOString(),
          cachedName: sourceName,
        }
        await repostInChannel(client, c, repost)
      }
    } catch (e) {
      // A publish that didn't land has to say so. The menu reads its state from the
      // manifest, so it corrects itself — what a reader would otherwise be left with is
      // a checkbox that quietly went back.
      addToast(
        `Could not update ${c.name}: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div ref={wrapper} className="relative flex items-center gap-1">
      {carrying > 0 && (
        <span className="text-xs tabular-nums text-neutral-500">
          {carrying}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        title={carrying > 0 ? 'Circulating this' : 'Repost'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Repost"
        className={`p-1 cursor-pointer transition-all duration-300 ${
          carrying > 0
            ? 'text-green-600 opacity-80 hover:opacity-100'
            : 'text-neutral-400 hover:text-green-600'
        }`}
      >
        <Recycle className="size-5" strokeWidth={1.5} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Repost to"
          // Keeps its own clicks off the row behind it; every item inside is a button.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="absolute bottom-full left-0 mb-1 z-20 min-w-56 bg-white border border-neutral-200 rounded-lg shadow-lg py-1"
        >
          <p className="px-3 py-1 text-xs uppercase tracking-wide text-neutral-500">
            Repost to
          </p>
          {channels.map((c) => (
            <button
              key={c.channelID}
              type="button"
              role="menuitemcheckbox"
              aria-checked={c.carries}
              disabled={busy !== null}
              onClick={() => void toggle(c)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-neutral-50 cursor-pointer disabled:cursor-default disabled:opacity-60"
            >
              <ChannelAvatar
                channelID={c.channelID}
                channelName={c.name}
                authorHandle=""
                avatar={c.avatar}
                size="sm"
              />
              <span className="flex-1 text-left text-neutral-900 truncate">
                {c.name}
              </span>
              {busy === c.channelID ? (
                <span
                  className="size-4 rounded-full border-2 border-neutral-300 border-t-green-600 animate-spin"
                  aria-hidden
                />
              ) : (
                c.carries && (
                  <Check className="size-4 text-green-600" aria-hidden />
                )
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
