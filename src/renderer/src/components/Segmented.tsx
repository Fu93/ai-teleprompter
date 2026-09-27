import type { JSX } from 'react'
import { cn } from '../lib/utils'

/** iOS 風分段控件 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className
}: {
  options: Array<{ id: T; label: string; icon?: React.ReactNode; title?: string }>
  value: T
  onChange: (id: T) => void
  className?: string
}): JSX.Element {
  return (
    <div className={cn('segmented', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          title={o.title ?? o.label}
          onClick={() => onChange(o.id)}
          className={cn('segmented-item', value === o.id && 'active')}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}
