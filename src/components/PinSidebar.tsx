import { HardDrive, X } from 'lucide-react'
import { type PinnedItemRef, usePinStore } from '../stores/pin'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { ChannelMark } from './ChannelMark'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function pinTitle(ref: PinnedItemRef): string {
  if (ref.item.title) return ref.item.title
  if (ref.item.summary) return ref.item.summary
  return '(untitled)'
}

function typeLabel(ref: PinnedItemRef): string {
  if (ref.item.type === 'text') return ref.item.title === '' ? 'Note' : 'Post'
  return ref.item.type.charAt(0).toUpperCase() + ref.item.type.slice(1)
}

export function PinSidebar({
  onItemClick,
}: {
  onItemClick?: (ref: PinnedItemRef) => void
}) {
  const sdk = useAuthStore((s) => s.sdk)
  const account = usePinStore((s) => s.account)
  const pinned = usePinStore((s) => s.pinned)
  const isPinning = usePinStore((s) => s.isPinning)
  const unpin = usePinStore((s) => s.unpin)
  const addToast = useToastStore((s) => s.addToast)

  const sorted = [...pinned].sort((a, b) =>
    b.pinnedAt.localeCompare(a.pinnedAt),
  )

  const pct =
    account && account.maxPinnedData > 0
      ? Math.min(100, (account.pinnedData / account.maxPinnedData) * 100)
      : 0

  const handleUnpin = async (e: React.MouseEvent, itemURL: string) => {
    e.stopPropagation()
    if (!sdk) return
    try {
      await unpin(sdk, itemURL)
      addToast('Unpinned')
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Unpin failed')
    }
  }

  return (
    <aside className="w-full xl:w-64 shrink-0 border border-neutral-200 rounded-lg bg-white p-3 space-y-5">
      <section className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          <HardDrive
            className="size-3.5 text-neutral-500"
            aria-hidden="true"
          />
          <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-500">
            Your storage
          </h2>
        </div>
        <div className="px-1 space-y-2">
          <div
            className="h-1.5 rounded-full bg-neutral-100 overflow-hidden"
            title={
              account
                ? `${formatBytes(account.pinnedSize)} encoded on the network`
                : undefined
            }
          >
            <div
              className="h-full bg-green-600 transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          {account ? (
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-neutral-900 font-medium">
                {formatBytes(account.pinnedData)}
              </span>
              <span className="text-neutral-500">
                of {formatBytes(account.maxPinnedData)}
              </span>
            </div>
          ) : (
            <p className="text-xs text-neutral-500">Loading…</p>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-semibold tracking-wide uppercase text-neutral-500 px-1">
          Pinned
        </h2>
        {sorted.length === 0 ? (
          <p className="text-xs text-neutral-500 px-1">
            Pin items to keep them in your storage.
          </p>
        ) : (
          <ul aria-label="Pinned items">
            {sorted.map((ref) => {
              const url = ref.item.itemURL
              const busy = isPinning(url)
              return (
                <li key={url} className="group relative">
                  <button
                    type="button"
                    onClick={() => onItemClick?.(ref)}
                    disabled={!onItemClick}
                    className="w-full px-2 py-1.5 rounded transition-colors text-left flex items-start gap-2 enabled:hover:bg-neutral-50 enabled:cursor-pointer"
                  >
                    <ChannelMark
                      channelID={ref.channel.channelID}
                      channelName={ref.channel.name}
                      authorHandle={ref.channel.authorHandle}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-xs font-medium text-neutral-900 truncate">
                        {pinTitle(ref)}
                      </p>
                      <p className="text-[10px] text-neutral-500 truncate">
                        {ref.channel.name} · {typeLabel(ref)}
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => handleUnpin(e, url)}
                    disabled={busy || !sdk}
                    title="Unpin"
                    aria-label={`Unpin ${pinTitle(ref)}`}
                    className="absolute top-1.5 right-1.5 p-1 rounded text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-50"
                  >
                    {busy ? (
                      <span className="block size-3 border-2 border-neutral-300 border-t-neutral-600 rounded-full animate-spin" />
                    ) : (
                      <X className="size-3" aria-hidden="true" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </aside>
  )
}
