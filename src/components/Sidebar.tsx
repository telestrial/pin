import { useAuthStore } from '../stores/auth'

const CAP = 10

export function Sidebar({
  onCreate,
  onSubscribe,
  onSeeAll,
  onChannelClick,
  activeChannelID,
}: {
  onCreate: () => void
  onSubscribe: () => void
  onSeeAll: () => void
  onChannelClick: (authorHandle: string, channelID: string) => void
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
                      className={`w-full text-left px-3 py-1.5 text-sm rounded transition-colors truncate disabled:opacity-50 cursor-pointer ${
                        active
                          ? 'bg-neutral-100 text-neutral-900 font-medium'
                          : 'text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50'
                      }`}
                    >
                      {c.name}
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
            <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider px-3 pt-2">
              Subscribed
            </h3>
            <ul>
              {subsToShow.map((s) => {
                const active = s.channelID === activeChannelID
                return (
                  <li key={`${s.authorHandle}/${s.channelID}`}>
                    <button
                      type="button"
                      onClick={() =>
                        onChannelClick(s.authorHandle, s.channelID)
                      }
                      className={`w-full text-left px-3 py-1.5 text-sm rounded transition-colors truncate cursor-pointer ${
                        active
                          ? 'bg-neutral-100 text-neutral-900 font-medium'
                          : 'text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50'
                      }`}
                    >
                      {s.cachedName ?? s.channelID}
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
