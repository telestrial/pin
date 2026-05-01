import { useAuthStore } from '../stores/auth'

const CAP = 10

export function Sidebar({
  onHome,
  onCreate,
  onSubscribe,
  onSeeAll,
  onChannelClick,
  activeHome,
  activeChannelID,
}: {
  onHome: () => void
  onCreate: () => void
  onSubscribe: () => void
  onSeeAll: () => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  activeHome?: boolean
  activeChannelID?: string
}) {
  const myChannels = useAuthStore((s) => s.myChannels)
  const subscriptions = useAuthStore((s) => s.subscriptions)

  const channelsToShow = [...myChannels]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, CAP)
  const subsToShow = [...subscriptions]
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .slice(0, CAP)

  const ownedAuthorHandle = (channelID: string) => {
    const sub = subscriptions.find((s) => s.channelID === channelID)
    return sub?.authorHandle
  }

  return (
    <aside className="w-full lg:w-60 shrink-0 border border-neutral-200 rounded-lg bg-white p-3 space-y-6">
      <section>
        <button
          type="button"
          onClick={onHome}
          className="w-full px-3 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 flex items-center justify-between gap-2 text-left"
        >
          <span>Home</span>
          {activeHome && (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-neutral-900 shrink-0"
            />
          )}
        </button>
      </section>

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
            <ul aria-label="Your channels">
              {channelsToShow.map((c) => {
                const handle = ownedAuthorHandle(c.channelID)
                const active = c.channelID === activeChannelID
                return (
                  <li key={c.channelID}>
                    <button
                      type="button"
                      onClick={() =>
                        handle && onChannelClick(handle, c.channelID)
                      }
                      disabled={!handle}
                      className="w-full px-3 py-1.5 text-sm rounded transition-colors disabled:opacity-50 cursor-pointer text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 flex items-center justify-between gap-2 text-left"
                    >
                      <span className="truncate">{c.name}</span>
                      {active && (
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-neutral-900 shrink-0"
                        />
                      )}
                    </button>
                  </li>
                )
              })}
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
            <ul aria-label="Subscribed channels">
              {subsToShow.map((s) => {
                const active = s.channelID === activeChannelID
                return (
                  <li key={`${s.authorHandle}/${s.channelID}`}>
                    <button
                      type="button"
                      onClick={() =>
                        onChannelClick(s.authorHandle, s.channelID)
                      }
                      className="w-full px-3 py-1.5 text-sm rounded transition-colors cursor-pointer text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 flex items-center justify-between gap-2 text-left"
                    >
                      <span className="truncate">
                        {s.cachedName ?? s.channelID}
                      </span>
                      {active && (
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-neutral-900 shrink-0"
                        />
                      )}
                    </button>
                  </li>
                )
              })}
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
