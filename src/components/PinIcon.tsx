import { Pin } from 'lucide-react'
import type { ComponentPropsWithoutRef } from 'react'

// Canonical pin glyph used everywhere — action affordances (compose
// forms, PinButton on feed rows, sidebar unpin) and brand surfaces
// (Navbar wordmark, AuthShell badge). Sized to match the armed-cursor
// SVG (22×22 → render close to size-5/20px) so the cursor, the brand,
// and the action icons all read at the same scale.
type PinIconProps = Omit<
  ComponentPropsWithoutRef<typeof Pin>,
  'size' | 'width' | 'height'
>

export function PinIcon({ className = '', ...rest }: PinIconProps) {
  return <Pin className={`size-5 ${className}`} {...rest} />
}
