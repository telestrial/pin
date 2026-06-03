// Decimal-divisor / decimal-label byte formatting (KB = 10³, MB = 10⁶,
// GB = 10⁹), matching how every consumer storage product labels caps:
// drive manufacturers, iCloud / Drive / Dropbox, OS file managers. The
// user's stated cap and what we render must match without arithmetic
// laundering. Internal binary quantities (slab capacity, shard sizes)
// keep their 1024-flavored constants — those are network-layer facts,
// not user-facing display.
//
// Trailing zeros are stripped: "50.00 GB" reads as "50 GB" because the
// .00 carries no information, but "50.01 GB" stays because the .01
// does. KB / MB cap at 1 fractional place; GB caps at 2.
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1000 * 1000) return `${trimTrailingZeros((n / 1000).toFixed(1))} KB`
  if (n < 1000 * 1000 * 1000) {
    return `${trimTrailingZeros((n / 1000 / 1000).toFixed(1))} MB`
  }
  return `${trimTrailingZeros((n / 1000 / 1000 / 1000).toFixed(2))} GB`
}

function trimTrailingZeros(s: string): string {
  // toFixed always emits the decimal point; strip trailing zeros, then
  // strip a now-orphaned trailing dot. Order matters: "50.10" → "50.1"
  // (drop one zero), "50.00" → "50" (drop both zeros, then the dot).
  return s.replace(/0+$/, '').replace(/\.$/, '')
}
