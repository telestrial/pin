import { Plus } from 'lucide-react'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { ChannelAvatar } from './channel/ChannelAvatar'

const CAP = 10

// Section header in the muted uppercase style shared with the right sidebar's
// "Recent pins" etc. The title itself links to the full management view
// (replacing the old per-section "See all"); the trailing + is the add action
// (create a channel / subscribe to one) — always available even when empty.
function SectionHeader({
  title,
  addLabel,
  onAdd,
  onTitleClick,
}: {
  title: string
  addLabel: string
  onAdd: () => void
  onTitleClick: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3">
      <h2>
        <button
          type="button"
          onClick={onTitleClick}
          className="text-xs font-semibold tracking-wide uppercase text-neutral-500 hover:text-neutral-900 transition-colors cursor-pointer"
        >
          {title}
        </button>
      </h2>
      <button
        type="button"
        onClick={onAdd}
        title={addLabel}
        aria-label={addLabel}
        className="text-neutral-400 hover:text-neutral-900 transition-colors cursor-pointer"
      >
        <Plus className="size-4" />
      </button>
    </div>
  )
}

export function Sidebar({
  onHome,
  onProfile,
  onCurate,
  onSettings,
  onCreate,
  onSubscribe,
  onSeeAll,
  onChannelClick,
  activeHome,
  activeProfile,
  activeCurate,
  activeSettings,
  activeChannelID,
}: {
  onHome: () => void
  // Only wired when the user has an atproto handle (Bluesky signed-in).
  // Just-Reading users see the rest of the sidebar but not this entry.
  onProfile?: () => void
  onCurate: () => void
  onSettings: () => void
  onCreate: () => void
  onSubscribe: () => void
  onSeeAll: () => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  activeHome?: boolean
  activeProfile?: boolean
  activeCurate?: boolean
  activeSettings?: boolean
  activeChannelID?: string
}) {
  const myChannels = useAuthStore((s) => s.myChannels)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const manifests = useFeedStore((s) => s.manifests)

  const ownedChannelIDs = new Set(myChannels.map((c) => c.channelID))
  const channelsToShow = [...myChannels]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, CAP)
  // A channel you own auto-subscribes you to itself (public ones also write a
  // self-follow claim), so it'd otherwise show under both Channels and
  // Subscriptions. It already lives under Channels — keep it out of subs.
  const visibleSubs = subscriptions.filter(
    (s) => !ownedChannelIDs.has(s.channelID),
  )
  const subsToShow = [...visibleSubs]
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .slice(0, CAP)

  const ownedAuthorHandle = (channelID: string) => {
    const sub = subscriptions.find((s) => s.channelID === channelID)
    return sub?.authorHandle
  }

  return (
    <aside className="w-full lg:w-60 shrink-0 border border-neutral-200 rounded-lg bg-white p-3">
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
        {onProfile && (
          <button
            type="button"
            onClick={onProfile}
            className="w-full px-3 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 flex items-center justify-between gap-2 text-left"
          >
            <span>Profile</span>
            {activeProfile && (
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-neutral-900 shrink-0"
              />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onCurate}
          className="w-full px-3 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 flex items-center justify-between gap-2 text-left"
        >
          <span>Curate</span>
          {activeCurate && (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-neutral-900 shrink-0"
            />
          )}
        </button>
        <button
          type="button"
          onClick={onSettings}
          className="w-full px-3 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 flex items-center justify-between gap-2 text-left"
        >
          <span>Settings</span>
          {activeSettings && (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-neutral-900 shrink-0"
            />
          )}
        </button>
      </section>

      <section className="space-y-2 mt-6">
        <SectionHeader
          title="Channels"
          addLabel="Create a channel"
          onAdd={onCreate}
          onTitleClick={onSeeAll}
        />
        {channelsToShow.length > 0 && (
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
                    className="w-full px-3 py-1.5 text-sm rounded transition-colors disabled:opacity-50 cursor-pointer text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 flex items-center gap-2 text-left"
                  >
                    <ChannelAvatar
                      channelID={c.channelID}
                      channelName={c.name}
                      authorHandle={handle ?? ''}
                      avatar={manifests[c.channelID]?.avatar}
                      size="xs"
                    />
                    <span className="truncate flex-1">{c.name}</span>
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
        )}
      </section>

      <section className="space-y-2 mt-3">
        <SectionHeader
          title="Subscriptions"
          addLabel="Subscribe to a channel"
          onAdd={onSubscribe}
          onTitleClick={onSeeAll}
        />
        {subsToShow.length > 0 && (
          <ul aria-label="Subscribed channels">
            {subsToShow.map((s) => {
              const active = s.channelID === activeChannelID
              return (
                <li key={`${s.authorHandle}/${s.channelID}`}>
                  <button
                    type="button"
                    onClick={() => onChannelClick(s.authorHandle, s.channelID)}
                    className="w-full px-3 py-1.5 text-sm rounded transition-colors cursor-pointer text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 flex items-center gap-2 text-left"
                  >
                    <ChannelAvatar
                      channelID={s.channelID}
                      channelName={s.cachedName ?? s.channelID}
                      authorHandle={s.authorHandle}
                      avatar={manifests[s.channelID]?.avatar}
                      size="xs"
                    />
                    <span className="truncate flex-1">
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
        )}
      </section>
    </aside>
  )
}
