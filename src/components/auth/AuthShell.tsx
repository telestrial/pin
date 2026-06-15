import { PinIcon } from '../pin/PinIcon'

// Wraps every AuthFlow screen so the Pin logo stays mounted and transitions
// in place across step changes. Grey + pulsing while we're booting (WASM
// init, restore attempts); fades to green when ready and reveals the
// children below.
export function AuthShell({
  ready,
  children,
}: {
  ready: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-12 bg-[radial-gradient(circle_at_top,var(--tw-gradient-stops))] from-green-50/40 via-white to-neutral-100">
      <div className="w-full max-w-md flex flex-col items-center">
        <div
          className={`inline-flex items-center justify-center size-14 rounded-2xl border transition-colors duration-500 ${
            ready
              ? 'bg-green-50 border-green-100'
              : 'bg-neutral-50 border-neutral-100 animate-pulse'
          }`}
          aria-hidden="true"
        >
          <PinIcon
            className={`transition-colors duration-500 ${
              ready ? 'text-green-600' : 'text-neutral-400'
            }`}
            fill="currentColor"
          />
        </div>
        {ready && children && (
          <div className="w-full mt-8 animate-fade-in">{children}</div>
        )}
      </div>
    </div>
  )
}
