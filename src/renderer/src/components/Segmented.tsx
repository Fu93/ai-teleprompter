import type { JSX } from 'react'
import { useRef } from 'react'
import { cn } from '../lib/utils'

/**
 * iOS 風分段控件。
 *
 * ── 為什麼不是 role="tablist" ──
 *   原本宣告 `role="tablist"` / `role="tab"` / `aria-selected`,但畫面上並沒有
 *   任何 tabpanel —— 切換後是同一個區塊換內容,不是「一個 panel 對一個 tab」。
 *   這會讓螢幕閱讀器建立一個不存在的 tab 模型並期待對應的 panel;
 *   而真正的 tablist 還要求方向鍵在項目間移動焦點、只有選取項可 Tab 到
 *   (roving tabindex),原本兩者都沒有 —— 於是 Tab 會逐顆停過去,
 *   與它宣告的語意互相矛盾。
 *
 *   正確而誠實的寫法是 `role="group"` + 每顆按鈕自己的 `aria-pressed`:
 *   「這是一組互斥的選項按鈕」正是實際的互動模型。方向鍵仍然支援(見下),
 *   只是它是加值而不是被 ARIA 語意強制的行為。
 *
 * 方向鍵:焦點在群組內時,←/→ 移動到上/下一顆並直接選取 ——
 * 這是 segmented control 使用者的直覺(與 Windows/macOS 的分段控件一致)。
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  ariaLabel
}: {
  options: Array<{ id: T; label: string; icon?: React.ReactNode; title?: string }>
  value: T
  onChange: (id: T) => void
  className?: string
  /** 群組的無障礙名稱。沒有文字標籤的分段控件(浮層工具列)一定要給。 */
  ariaLabel?: string
}): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const idx = options.findIndex((o) => o.id === value)
    if (idx < 0) return
    e.preventDefault()
    const next = e.key === 'ArrowRight' ? (idx + 1) % options.length : (idx - 1 + options.length) % options.length
    onChange(options[next].id)
    // 焦點跟著走:只改選取而不移動焦點,鍵盤使用者會失去位置感
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button')
    buttons?.[next]?.focus()
  }

  return (
    <div
      ref={listRef}
      role="group"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn('segmented', className)}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
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
