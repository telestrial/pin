import { useMemo } from 'react'
import type { Facet } from '../core/types'
import { renderPostBody } from '../lib/markdown'

// Words with mentions in them, wherever they were written.
//
// Shared by a post's body and a comment's, because a mention has to look and behave the
// same in both: the anchor a reader clicks carries the handle, and what it resolves to is
// the DID the facet named. A comment carries facets exactly as a post does, so rendering
// them twice would be two chances for one surface to show an @name that goes nowhere.

export function RichBody({
  body,
  facets,
  onHandleClick,
  textClass = 'text-sm',
}: {
  body: string
  facets?: Facet[]
  /** Absent where there is nowhere to send anyone — the mention still renders as text. */
  onHandleClick?: (handle: string) => void
  /** Type size, which is the one thing that legitimately differs by where this is read: a
   *  row in a list is small, and a post opened on its own page is not. */
  textClass?: string
}) {
  const html = useMemo(() => renderPostBody(body, facets), [body, facets])
  if (!body) return null

  // Delegated: a click on an injected mention anchor navigates to that handle's directory
  // and is kept from bubbling to the row's open click. The anchors are native <a>, so
  // keyboard activation works through them.
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a[data-mention-handle]')
    if (!a) return
    e.preventDefault()
    e.stopPropagation()
    const handle = a.getAttribute('data-mention-handle') ?? ''
    if (handle) onHandleClick?.(handle)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click delegates to nested <a> mentions, which are natively interactive
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegates to nested <a> mentions, which are natively keyboard-accessible
    <div
      className={`markdown wrap-break-word text-neutral-900 ${textClass}`}
      onClick={handleClick}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via DOMPurify
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
