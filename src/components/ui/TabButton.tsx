// Underline-style tab button shared by My Storage's top tabs (My Files /
// My Channels) and the channel storage detail's sub-tabs (Files / Posts).
export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px px-1 pb-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
        active
          ? 'border-green-600 text-neutral-900'
          : 'border-transparent text-neutral-500 hover:text-neutral-900'
      }`}
    >
      {children}
    </button>
  )
}
