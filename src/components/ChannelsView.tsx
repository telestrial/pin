import { buildSubscribeURL } from '../core/channels'
import { useAuthStore } from '../stores/auth'
import { CopyButton } from './CopyButton'

export function ChannelsView({ onCancel }: { onCancel: () => void }) {
  const myChannels = useAuthStore((s) => s.myChannels)
  const subscriptions = useAuthStore((s) => s.subscriptions)
  const session = useAuthStore((s) => s.atprotoSession)

  return (
    <div className="flex-1 p-6">
      <div className="max-w-2xl mx-auto space-y-8">
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
              {myChannels.map((c) => (
                <li
                  key={c.channelID}
                  className="py-3 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-neutral-900 truncate">
                      {c.name}
                    </p>
                    <p className="text-[11px] font-mono text-neutral-400 truncate">
                      {c.channelID}
                    </p>
                  </div>
                  {session && (
                    <div className="shrink-0">
                      <CopyButton
                        value={buildSubscribeURL(session.handle, c.channelKey)}
                        label="Subscribe URL copied"
                      />
                    </div>
                  )}
                </li>
              ))}
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
              {subscriptions.map((s) => (
                <li key={`${s.authorHandle}/${s.channelID}`} className="py-3">
                  <p className="text-sm text-neutral-900 truncate">
                    {s.cachedName ?? s.channelID}
                  </p>
                  <p className="text-xs text-neutral-500 truncate">
                    @{s.authorHandle}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2.5 bg-neutral-100 hover:bg-neutral-200 text-neutral-900 text-sm font-medium rounded-lg transition-colors"
        >
          Back
        </button>
      </div>
    </div>
  )
}
