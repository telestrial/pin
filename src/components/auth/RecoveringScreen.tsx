import { AuthShell } from './AuthShell'

// Shown when a RESTORE hasn't managed to read its settings yet.
//
// It exists because the alternative lies. Without it the app renders with no
// channels, no subscriptions and no profile — indistinguishable from a brand-new
// account — which invites you to fill it all in again, and filling it in is a
// settings mutation that would publish your emptiness over the real record.
//
// So this is deliberately a wall rather than a warning: while we don't know what
// your settings are, there's nothing useful to do and one genuinely harmful thing
// to do. The recovery keeps retrying underneath (the durable pkarr pointer resolves
// through relays that lag), and another instance of the same identity syncing its
// copy over will also close this.
export function RecoveringScreen() {
  return (
    <AuthShell ready>
      <div className="space-y-3 text-center">
        <h1 className="text-2xl font-semibold text-neutral-900 tracking-tight">
          Finding your account
        </h1>
        <p className="text-neutral-600 text-[15px] leading-relaxed">
          Your channels and profile live on the network, and this device is
          still reaching for them. It can take a minute.
        </p>
        <p className="text-neutral-500 text-[13px] leading-relaxed">
          Nothing is saved until they arrive, so nothing you already have can be
          overwritten. Leaving another signed-in device open will speed this up.
        </p>
      </div>
    </AuthShell>
  )
}
