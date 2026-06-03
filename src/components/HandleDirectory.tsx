import { useParams } from 'react-router-dom'

export function HandleDirectory() {
  const { handle } = useParams<{ handle: string }>()
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-3">
        <h1 className="text-xl font-semibold text-neutral-900">
          @{handle}
        </h1>
        <p className="text-neutral-500 text-sm">
          Handle directory page coming soon.
        </p>
      </div>
    </div>
  )
}
