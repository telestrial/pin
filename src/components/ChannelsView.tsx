import { buildSubscribeURL } from '../core/channels'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { CopyButton } from './CopyButton'
import { FormCard } from './FormCard'

export function ChannelsView({
  onCancel,
  onChannelClick,
  onUnsubscribe,
  sidebar,
  rightSidebar,
}: {
  onCancel: () => void
  onChannelClick: (authorHandle: string, channelID: string) => void
  onUnsubscribe?: (channelID: string, name: string) => void
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
}) {
  const myChannels = useAuthStore((s) => s.myChannels)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const session = useAuthStore((s) => s.atprotoSession)
  const errors = useFeedStore((s) => s.errors)

  return (
    <FormCard
      sidebar={sidebar}
      rightSidebar={rightSidebar}
      onBack={onCancel}
    >
      <h1 className="text-xl font-semibold text-neutral-900">Channels</h1>

        <section className="space-y-3">
          <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            Your channels ({myChannels.length})
          </h2>
          {myChannels.length === 0 ? (
            <p className="text-sm text-neutral-500">
              You don't own any channels yet.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-200/80">
              {myChannels.map((c) => {
                const sub = subscriptions.find(
                  (s) => s.channelID === c.channelID,
                )
                const handle = sub?.authorHandle ?? session?.handle
                return (
                  <li
                    key={c.channelID}
                    className="py-3 flex items-center justify-between gap-4"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        handle && onChannelClick(handle, c.channelID)
                      }
                      disabled={!handle}
                      className="min-w-0 flex-1 text-left hover:bg-neutral-50 -mx-2 px-2 py-1 rounded transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      <p className="text-sm text-neutral-900 truncate">
                        {c.name}
                      </p>
                      <p className="text-[11px] font-mono text-neutral-400 truncate">
                        {c.channelID}
                      </p>
                    </button>
                    {session && (
                      <div className="shrink-0">
                        <CopyButton
                          value={buildSubscribeURL(
                            session.handle,
                            c.channelKey,
                          )}
                          label="Subscribe URL copied"
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            Subscribed ({subscriptions.length})
          </h2>
          {subscriptions.length === 0 ? (
            <p className="text-sm text-neutral-500">
              You haven't subscribed to anything yet.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-200/80">
              {subscriptions.map((s) => {
                const error = errors.find((e) => e.channelID === s.channelID)
                const name = s.cachedName ?? s.channelID
                return (
                  <li
                    key={`${s.authorHandle}/${s.channelID}`}
                    className="py-3 flex items-center gap-3"
                  >
                    <button
                      type="button"
                      onClick={() => onChannelClick(s.authorHandle, s.channelID)}
                      className="min-w-0 flex-1 text-left hover:bg-neutral-50 -mx-2 px-2 py-1 rounded transition-colors cursor-pointer"
                    >
                      <p className="text-sm text-neutral-900 truncate">
                        {name}
                      </p>
                      <p className="text-xs text-neutral-500 truncate">
                        @{s.authorHandle}
                      </p>
                      {error && (
                        <p className="text-xs text-red-600 mt-1 wrap-break-word">
                          Failed to load: {error.error}
                        </p>
                      )}
                    </button>
                    {onUnsubscribe && (
                      <button
                        type="button"
                        onClick={() => onUnsubscribe(s.channelID, name)}
                        className="shrink-0 px-2.5 py-1 text-xs font-medium text-neutral-500 hover:text-red-700 bg-neutral-50 hover:bg-red-50 rounded-md transition-colors cursor-pointer"
                      >
                        Unsubscribe
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
      </section>
    </FormCard>
  )
}
