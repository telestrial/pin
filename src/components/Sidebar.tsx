import { Plus, RotateCw, X } from 'lucide-react'
import {
  type Action,
  type ChannelCreateAction,
  CREATE_PHASE_UPLOADING,
  useActionStore,
} from '../stores/actionQueue'
import { useAuthStore } from '../stores/auth'
import { useFeedStore } from '../stores/feed'
import { ChannelAvatar } from './channel/ChannelAvatar'
import { Invitations } from './Invitations'

const CAP = 10

// What a channel being set up is doing, in words. The journal runs one action at a time,
// so a create queued behind a post still uploading is WAITING, and saying so is the
// difference between a row that reads as slow and one that reads as stuck.
function settingUpStatus(a: ChannelCreateAction, actions: Action[]): string {
  if (a.state === 'failed') return "Couldn't set up"
  if (a.state === 'pending') {
    const busy = actions.some((x) => x.state === 'running' && x.id !== a.id)
    return busy ? 'Waiting for another upload…' : 'Starting…'
  }
  if (a.phase === CREATE_PHASE_UPLOADING) {
    return `${CREATE_PHASE_UPLOADING} · ${Math.round(a.progress)}%`
  }
  return a.phase ? `${a.phase}…` : 'Setting up…'
}

// Section header in the muted uppercase style shared with the right sidebar's
// "Recent pins" etc. The title itself links to the full management view
// (replacing the old per-section "See all"); the trailing + is the add action
// (create a channel / open a link to one) — always available even when empty.
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
  onOpenLink,
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
  // Opens the address bar. Navigation, not a way to acquire a channel — what relation
  // to have with what it opens is decided on the page it lands on.
  onOpenLink: () => void
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
  const follows = useAuthStore((s) => s.follows)
  const manifests = useFeedStore((s) => s.manifests)

  const actions = useActionStore((s) => s.actions)
  const retryAction = useActionStore((s) => s.retry)
  const removeAction = useActionStore((s) => s.remove)

  const ownedChannelIDs = new Set(myChannels.map((c) => c.channelID))
  // Channels still being set up, drawn from the journal rather than from settings. A
  // channel enters settings only once its manifest is published, because settings is
  // what the identity loop advertises — so without this the sidebar would say nothing
  // about a channel for as long as its images upload. Keyed by the channelID minted at
  // enqueue, so the moment the commit lands the real entry takes the same slot and this
  // one drops out.
  const settingUp = actions
    .filter(
      (a): a is ChannelCreateAction =>
        a.kind === 'channel-create' &&
        a.state !== 'success' &&
        !ownedChannelIDs.has(a.intent.channelID),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const channelsToShow = [...myChannels]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, CAP)
  // A channel you own auto-subscribes you to itself (public ones also write a
  // self-follow claim), so it'd otherwise show under both Channels and this
  // list. It already lives under Channels — keep it out.
  const visibleSubs = subscriptions.filter(
    (s) => !ownedChannelIDs.has(s.channelID),
  )
  const subsToShow = [...visibleSubs]
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .slice(0, CAP)

  return (
    <aside className="w-full lg:w-60 shrink-0 border border-neutral-200 rounded-lg bg-white p-3 lg:max-h-full lg:overflow-y-auto">
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
        {channelsToShow.length + settingUp.length > 0 && (
          <ul aria-label="Your channels">
            {settingUp.map((a) => {
              const failed = a.state === 'failed'
              return (
                <li
                  key={a.intent.channelID}
                  aria-busy={!failed}
                  className="px-3 py-1.5 text-sm rounded flex items-center gap-2"
                >
                  {failed ? (
                    <ChannelAvatar
                      channelID={a.intent.channelID}
                      channelName={a.intent.name}
                      authorHandle=""
                      size="xs"
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="size-5 shrink-0 flex items-center justify-center"
                    >
                      <span className="block size-3.5 rounded-full border-2 border-neutral-300 border-t-green-600 animate-spin" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-neutral-900">
                      {a.intent.name}
                    </span>
                    <span
                      // The error in full on hover: the row has room for the fact of
                      // the failure, and the message is for whoever wants the detail.
                      title={failed ? a.error : undefined}
                      className={`block text-[10px] truncate ${failed ? 'text-red-600' : 'text-green-700 animate-pulse'}`}
                    >
                      {settingUpStatus(a, actions)}
                    </span>
                  </span>
                  {failed && (
                    <span className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => retryAction(a.id)}
                        title="Retry"
                        aria-label={`Retry setting up ${a.intent.name}`}
                        className="p-1 rounded text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 cursor-pointer"
                      >
                        <RotateCw className="size-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeAction(a.id)}
                        title="Dismiss"
                        aria-label={`Dismiss ${a.intent.name}`}
                        className="p-1 rounded text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 cursor-pointer"
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </span>
                  )}
                </li>
              )
            })}
            {channelsToShow.map((c) => {
              const active = c.channelID === activeChannelID
              return (
                <li key={c.channelID}>
                  <button
                    type="button"
                    // The channel view resolves K by channelID (from your subs),
                    // so the authorHandle arg isn't load-bearing — pass empty.
                    onClick={() => onChannelClick('', c.channelID)}
                    className="w-full px-3 py-1.5 text-sm rounded transition-colors cursor-pointer text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50 flex items-center gap-2 text-left"
                  >
                    <ChannelAvatar
                      channelID={c.channelID}
                      channelName={c.name}
                      authorHandle=""
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

      <Invitations />

      <section className="space-y-2 mt-3">
        {/* Everything that reaches you, which is follows AND watches: a subscription is
            the mechanism under both, so a list of them is a list of what you follow at
            either visibility. Titled for the superset, and the private ones say so on the
            row — the profile's Following is the PUBLIC subset of this, which is a
            different claim for a different audience. */}
        <SectionHeader
          title="Following"
          addLabel="Open a Pin link"
          onAdd={onOpenLink}
          onTitleClick={onSeeAll}
        />
        {subsToShow.length > 0 && (
          <ul aria-label="Channels you follow or watch">
            {subsToShow.map((s) => {
              const active = s.channelID === activeChannelID
              // Public unless nothing in the directory claims it. Marking the PRIVATE
              // ones because public is what the heading already says, so the exception
              // is the thing worth showing.
              const watchingOnly = !follows.some(
                (f) => f.channelID === s.channelID,
              )
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
                    {watchingOnly && (
                      <span
                        title="Watching — private, and nobody can read it off you"
                        className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-400"
                      >
                        Watching
                      </span>
                    )}
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
