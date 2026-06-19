import { useAuthStore } from '../stores/auth'
import { AuthShell } from './auth/AuthShell'

// The soft-lock gate. Shown in place of Home when the session is locked
// (auth.locked). The session is still live behind it, so Continue returns
// instantly — nothing reconnects. Reuses AuthShell so the grey→green Pin
// and fade-in match the real auth screen.
export function LockScreen({ onContinue }: { onContinue: () => void }) {
  const handle = useAuthStore((s) => s.atprotoHandle)

  return (
    <AuthShell ready>
      <div className="flex flex-col items-center gap-5 text-center">
        <p className="text-sm text-neutral-600">
          {handle ? (
            <>
              Welcome back,{' '}
              <span className="font-medium text-neutral-900">@{handle}</span>
            </>
          ) : (
            'Welcome back'
          )}
        </p>
        <button
          type="button"
          onClick={onContinue}
          className="px-5 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-full transition-colors cursor-pointer"
        >
          Continue
        </button>
      </div>
    </AuthShell>
  )
}
