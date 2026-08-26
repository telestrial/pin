import type { FeedChannel } from '../core/feed'
import {
  useIdentityName,
  useIdentityProfile,
} from '../lib/hooks/useIdentityName'
import { formatAbsolute, formatRelativeShort } from '../lib/time'
import { ChannelAvatar } from './channel/ChannelAvatar'
import { IdentityAvatar } from './IdentityAvatar'

// The shape of one row, wherever a row appears.
//
// A post and a comment are the same thing to a reader: somebody said something, at a time,
// with things you can do about it. So there is ONE component that knows what that looks
// like, and it takes an identity that is either a channel or a person.
//
// The two identities are genuinely different, and that difference is the whole reason this
// exists. A post is published BY A CHANNEL — its avatar, its name, the author's handle
// beneath. A comment is written by a PERSON, who has no channel at all: they have a did:dht
// and a profile they gave themselves, with a display name, a @username and an avatar,
// fetched a different way from a different record. Rendering both through one component is
// what stops them drifting apart, which two lookalike components reliably do.

/** Who made a thing, as a row's header renders it.
 *
 *  Tagged rather than discriminated on which fields are present, so "this is a person" is
 *  one fact the type holds instead of two that could disagree. */
export type RowIdentity =
  | { kind: 'channel'; channel: FeedChannel }
  | { kind: 'person'; didDht: string }

/** What a row's identity is called, and what its avatar is.
 *
 *  Both hooks run unconditionally — hooks cannot sit behind a branch — and the one that
 *  doesn't apply is handed an empty id, which resolves to nothing and fetches nothing. */
function useWho(identity: RowIdentity) {
  const person = useIdentityProfile(
    identity.kind === 'person' ? identity.didDht : '',
  )
  const personName = useIdentityName(
    identity.kind === 'person' ? identity.didDht : '',
  )
  const channelAuthor = useIdentityName(
    identity.kind === 'channel' ? (identity.channel.authorDidDht ?? '') : '',
  )

  if (identity.kind === 'person') {
    return {
      // Display name over handle, the way every profile surface reads: the name is what
      // somebody calls themselves, the handle is how you address them. Neither is unique
      // and nothing structural depends on either — identity is the DID.
      title: person?.displayName || `@${personName}`,
      // Only when the title isn't already the handle, or the row says it twice.
      subtitle: person?.displayName ? `@${personName}` : null,
      name: personName,
      avatarURL: person?.avatarURL ?? undefined,
    }
  }
  const { channel } = identity
  const author = channel.authorDidDht ? channelAuthor : channel.authorHandle
  return {
    title: channel.name,
    // did:dht subs show the identity-doc username; legacy subs the atproto handle. Absent
    // only when neither identifier exists.
    subtitle:
      channel.authorDidDht || channel.authorHandle ? `@${author}` : null,
    name: author,
    avatarURL: undefined,
  }
}

/** One row: who, when, and whatever the thing itself is.
 *
 *  `above` is the line a repost puts over everything ("Reposted by @carol"). `children` is
 *  the body, its files and its gestures — in that order, by every caller, because that
 *  ordering IS the row shape.
 */
export function PostRow({
  identity,
  at,
  editedAt,
  above,
  onOpen,
  onOpenChannel,
  onOpenPerson,
  children,
}: {
  identity: RowIdentity
  at: string
  editedAt?: string
  above?: React.ReactNode
  /** Opening the thing itself. Absent where the row IS the thing, already open. */
  onOpen?: () => void
  onOpenChannel?: (channel: FeedChannel) => void
  onOpenPerson?: (id: string) => void
  children: React.ReactNode
}) {
  const who = useWho(identity)

  const openHeading = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (identity.kind === 'channel') return onOpenChannel?.(identity.channel)
    onOpenPerson?.(identity.didDht)
  }
  const openPerson = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (identity.kind === 'person') return onOpenPerson?.(identity.didDht)
    const { channel } = identity
    onOpenPerson?.(channel.authorDidDht || channel.authorHandle)
  }

  const body = (
    <>
      {above}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={openHeading}
          className="self-start shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-green-600 cursor-pointer"
          aria-label={
            identity.kind === 'channel'
              ? `View channel ${who.title}`
              : `View ${who.name}`
          }
        >
          {identity.kind === 'channel' ? (
            <ChannelAvatar
              channelID={identity.channel.channelID}
              channelName={identity.channel.name}
              authorHandle={identity.channel.authorHandle}
              avatar={identity.channel.avatar}
            />
          ) : (
            <IdentityAvatar
              didDht={identity.didDht}
              name={who.name}
              avatarURL={who.avatarURL}
            />
          )}
        </button>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              <button
                type="button"
                onClick={openHeading}
                className="block max-w-full text-sm font-semibold text-neutral-900 truncate hover:underline cursor-pointer text-left"
              >
                {who.title}
              </button>
              {who.subtitle && (
                <button
                  type="button"
                  onClick={openPerson}
                  className="block max-w-full text-xs text-neutral-500 truncate hover:underline cursor-pointer text-left"
                >
                  {who.subtitle}
                </button>
              )}
            </div>
            <p
              className="text-xs text-neutral-500 whitespace-nowrap shrink-0"
              title={formatAbsolute(at)}
            >
              {formatRelativeShort(at)}
              {editedAt && (
                <span title={`Edited ${formatAbsolute(editedAt)}`}>
                  {' · edited '}
                  {formatRelativeShort(editedAt)}
                </span>
              )}
            </p>
          </div>
          {children}
        </div>
      </div>
    </>
  )

  if (!onOpen) return <div className="py-4">{body}</div>

  return (
    /* biome-ignore lint/a11y/useSemanticElements: the row contains nested interactives (channel buttons, pin, audio/video controls), so a button element would nest them */
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="py-4 px-2 -mx-2 rounded hover:bg-neutral-50 cursor-pointer transition-colors"
    >
      {body}
    </div>
  )
}
