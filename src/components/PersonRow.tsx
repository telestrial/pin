import {
  useIdentityName,
  useIdentityProfile,
} from '../lib/hooks/useIdentityName'
import { IdentityAvatar } from './IdentityAvatar'

/** One person in a list of people.
 *
 *  Shared by every list of people — who a profile follows, who follows it, who follows a
 *  channel, who is a member of one — so they cannot drift into different rows. A mark, a
 *  name, an optional second line, and it opens their directory. The person is named by their own published
 *  profile, which `useIdentityName` reads out of the crawl's index before the network.
 *
 *  `action` sits beside the row rather than inside it, so pressing it does not also open
 *  the person. */
export function PersonRow({
  didDht,
  via,
  action,
  onHandleClick,
}: {
  didDht: string
  via?: string
  action?: React.ReactNode
  onHandleClick: (handle: string) => void
}) {
  const name = useIdentityName(didDht)
  const profile = useIdentityProfile(didDht)
  return (
    <div className="flex items-center hover:bg-neutral-50 transition-colors">
      <button
        type="button"
        onClick={() => onHandleClick(didDht)}
        className="flex-1 min-w-0 p-3 flex gap-3 items-center text-left cursor-pointer"
      >
        <IdentityAvatar
          didDht={didDht}
          name={name}
          avatarURL={profile?.avatarURL ?? undefined}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-neutral-900 truncate">
            @{name}
          </div>
          {via && (
            <div className="text-xs text-neutral-500 truncate">{via}</div>
          )}
        </div>
      </button>
      {action && <div className="shrink-0 pr-3">{action}</div>}
    </div>
  )
}
