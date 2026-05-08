import { X } from 'lucide-react'
import { SlabInspector } from './SlabInspector'

export function MyStorage({
  sidebar,
  rightSidebar,
  onClose,
}: {
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="flex-1 p-6">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <div className="flex-1 min-w-0">
          <div className="bg-white border border-neutral-200 rounded-lg p-5 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-2xl font-semibold text-neutral-900">
                My Storage
              </h1>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="p-1.5 rounded-full text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 transition-colors cursor-pointer shrink-0"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <SlabInspector />
          </div>
        </div>
        {rightSidebar}
      </div>
    </div>
  )
}
