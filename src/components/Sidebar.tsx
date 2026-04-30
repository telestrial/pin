import { useAuthStore } from '../stores/auth'

const CAP = 10

export function Sidebar({
  onCreate,
  onSubscribe,
  onSeeAll,
}: {
  onCreate: () => void
  onSubscribe: () => void
  onSeeAll: () => void
}) {
  const myChannels = useAuthStore((s) => s.myChannels)
  const subscriptions = useAuthStore((s) => s.subscriptions)

  const channelsToShow = [...myChannels]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, CAP)
  const subsToShow = [...subscriptions]
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .slice(0, CAP)

  return (
    <aside className="w-full lg:w-60 shrink-0 space-y-6">
      <section className="space-y-2">
        <button
          type="button"
          onClick={onCreate}
          className="w-full text-left px-3 py-2 text-sm font-medium text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors cursor-pointer"
        >
          + Create a channel
        </button>
        {channelsToShow.length > 0 && (
          <>
            <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider px-3 pt-2">
              Your channels
            </h3>
            <ul>
              {channelsToShow.map((c) => (
                <li
                  key={c.channelID}
                  className="px-3 py-1.5 text-sm text-neutral-700 truncate"
                >
                  {c.name}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onSeeAll}
              className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors underline underline-offset-2 px-3"
            >
              See all ({myChannels.length})
            </button>
          </>
        )}
      </section>

      <section className="space-y-2">
        <button
          type="button"
          onClick={onSubscribe}
          className="w-full text-left px-3 py-2 text-sm font-medium text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors cursor-pointer"
        >
          + Subscribe
        </button>
        {subsToShow.length > 0 && (
          <>
            <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider px-3 pt-2">
              Subscribed
            </h3>
            <ul>
              {subsToShow.map((s) => (
                <li
                  key={`${s.authorHandle}/${s.channelID}`}
                  className="px-3 py-1.5 text-sm text-neutral-700 truncate"
                >
                  {s.cachedName ?? s.channelID}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onSeeAll}
              className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors underline underline-offset-2 px-3"
            >
              See all ({subscriptions.length})
            </button>
          </>
        )}
      </section>
    </aside>
  )
}
