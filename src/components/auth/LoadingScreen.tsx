import { Pin } from 'lucide-react'

export function LoadingScreen({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4">
      <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-green-50 border border-green-100 animate-pulse">
        <Pin className="size-7 text-green-600" fill="currentColor" />
      </div>
      <p className="text-neutral-500 text-sm">{message || 'Starting up…'}</p>
    </div>
  )
}
