export function FormCard({
  sidebar,
  rightSidebar,
  onBack,
  children,
}: {
  sidebar?: React.ReactNode
  rightSidebar?: React.ReactNode
  onBack?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex-1 p-6">
      <div className="flex flex-col lg:flex-row lg:items-start gap-6">
        {sidebar}
        <div className="flex-1 min-w-0">
          <div className="bg-white border border-neutral-200 rounded-lg p-5 space-y-5">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 bg-neutral-100 hover:bg-neutral-200 rounded-full transition-colors cursor-pointer"
              >
                Back
              </button>
            )}
            {children}
          </div>
        </div>
        {rightSidebar}
      </div>
    </div>
  )
}
