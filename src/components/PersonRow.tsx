import {
  useIdentityName,
  useIdentityProfile,
} from '../lib/hooks/useIdentityName'
import { IdentityAvatar } from './IdentityAvatar'

/** One person in a list of people.
 *
 *  Shared by every list of people — who a profile follows, who follows it, who follows a
 *  channel — so the three cannot drift into three different rows. A mark, a name, an
 *  optional second line, and it opens their directory. The person is named by their own published
 *  profile, which `useIdentityName` reads out of the crawl's index before the network. */
export function PersonRow({
  didDht,
  via,
  onHandleClick,
}: {
  didDht: string
  via?: string
  onHandleClick: (handle: string) => void
}) {
  const name = useIdentityName(didDht)
  const profile = useIdentityProfile(didDht)
  return (
    <button
      type="button"
      onClick={() => onHandleClick(didDht)}
      className="w-full p-3 flex gap-3 items-center text-left hover:bg-neutral-50 cursor-pointer transition-colors"
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
        {via && <div className="text-xs text-neutral-500 truncate">{via}</div>}
      </div>
    </button>
  )
}
