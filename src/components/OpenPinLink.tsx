import { useState } from 'react'
import { parsePinAddress } from '../core/channels'
import { FormCard } from './ui/FormCard'

/** Go to a Pin address.
 *
 *  Pasting a link is NAVIGATION, not a way to acquire things. The link is an address, and
 *  opening it is a read — which relation to have with what you find is a decision the page
 *  you land on carries, alongside every other route to that page. So this is tantamount to
 *  clicking an author in a post, landing on their profile and opening one of their
 *  channels: the same views, reached a different way.
 *
 *  It used to watch what it opened, which made it a second place where the follow/watch
 *  question got answered — and answered by default, without the buttons that exist to
 *  answer it. That is also why nothing here fetches: it resolves no manifest, checks no
 *  subscription, and touches no store. A link that names something unreadable is a page
 *  that says so, not an error in a box.
 *
 *  Which leaves it as what it practically is: a debug affordance. The network is something
 *  you traverse — search, profiles, portals — and this is the way in when somebody hands
 *  you an address directly. */
export function OpenPinLink({
  onCancel,
  onOpenChannel,
  onOpenProfile,
  sidebar,
  rightSidebar,
}: {
  onCancel: () => void
  onOpenChannel: (
    authorHandle: string,
    didDht: string | undefined,
    channelID: string,
    channelKey: string,
  ) => void
  onOpenProfile: (didDht: string) => void
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return
    setError(null)
    try {
      const addr = await parsePinAddress(trimmed)
      if (addr.kind === 'identity') return onOpenProfile(addr.didDht)
      onOpenChannel(
        addr.authorHandle,
        addr.didDht,
        addr.channelID,
        addr.channelKey,
      )
    } catch (e) {
      // Only ever a parse failure — whether the address leads anywhere is the destination's
      // question, and it is better answered by the page than guessed at here.
      setError(e instanceof Error ? e.message : 'Not a Pin link')
    }
  }

  return (
    <FormCard sidebar={sidebar} rightSidebar={rightSidebar} onBack={onCancel}>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-neutral-900">
            Open a Pin link
          </h1>
          <p className="text-neutral-500 text-sm">
            A link to a channel carries its author's identity and the key that
            reads it; a link to a person carries just their identity. Either one
            opens — what to do about it is on the page.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-neutral-700 uppercase tracking-wider">
            Pin link
          </span>
          <textarea
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            rows={3}
            placeholder="pin://did:dht:…#k=…  or  pin://did:dht:…"
            className="w-full px-3 py-2 bg-white border border-neutral-300 rounded-lg text-[11px] font-mono text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
          />
        </label>

        {error && (
          <p className="text-red-600 text-sm wrap-break-word">{error}</p>
        )}

        <button
          type="submit"
          disabled={!url.trim()}
          className="w-full px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Open
        </button>
      </form>
    </FormCard>
  )
}
