/**
 * ConfirmDialog.tsx — App 內確認對話框的畫面(狀態在 lib/confirm.ts)。
 *
 * 取代七處原生 window.confirm。除了風格外,原生對話框還少了三件這裡有做的事:
 *   1. 焦點鎖在對話框內:Tab 不會跑到背後被遮住的側欄與設定欄位
 *   2. Esc 一律等於「取消」(原生在 Electron 的行為由系統決定)
 *   3. 關閉後把焦點還原到開啟前的元素 —— 否則焦點掉回 body,
 *      鍵盤使用者得從頭 Tab 一次
 *
 * 預設焦點刻意放在「取消」:破壞性操作不該讓 Enter 直接生效。
 */
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '../lib/utils'
import { useConfirm } from '../lib/confirm'
import { useEscape } from '../lib/useEscape'

export function ConfirmHost(): JSX.Element | null {
  const current = useConfirm((s) => s.current)
  const settle = useConfirm((s) => s.settle)

  const boxRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<Element | null>(null)

  // 開啟時記住焦點來源、把焦點移進對話框;關閉後還原
  useEffect(() => {
    if (!current) return
    restoreRef.current = document.activeElement
    // 下一個 frame 再聚焦:此時 dialog 才在 DOM 裡
    const t = requestAnimationFrame(() => cancelRef.current?.focus())
    return () => {
      cancelAnimationFrame(t)
      if (restoreRef.current instanceof HTMLElement && document.contains(restoreRef.current)) {
        restoreRef.current.focus()
      }
    }
  }, [current])

  // Tab / Shift+Tab 在對話框內循環
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab') return
    const box = boxRef.current
    if (!box) return
    const focusables = box.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  useEscape(() => settle(false), !!current)

  if (!current) return null

  const danger = current.variant === 'danger'

  return (
    <div
      // data-modal-backdrop:宣告「這個覆蓋是設計要的」。
      // 沒有它, domAudit 的 text-covered 會把遮罩底下的側欄、編輯器、工具列
      // 全部報成缺陷 —— 而「對話框蓋住背景」正是模態的定義。
      // 一個必然的覆蓋若永遠留在報告裡,只會訓練人忽略報告(同一個道理見
      // 浮層救援卡的 data-overlay-card)。真正要查的是「沒有對話框時誰蓋住了文字」。
      data-modal-backdrop="1"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-6"
      // 點背景 = 取消(與 Esc 一致);點對話框內部不關閉
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle(false)
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={current.body ? 'confirm-body' : undefined}
        onKeyDown={onKeyDown}
        className="glass anim-rise w-full max-w-[420px] rounded-2xl border border-white/12 p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          {danger && (
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-450/15">
              <AlertTriangle size={16} className="text-rose-450" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div id="confirm-title" className="text-sm font-semibold text-ink-100">
              {current.title}
            </div>
            {current.body && (
              <div id="confirm-body" className="mt-1.5 text-xs leading-relaxed text-ink-300">
                {current.body}
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            className="btn-outline text-xs"
            onClick={() => settle(false)}
            data-confirm="cancel"
          >
            {current.cancelLabel ?? '取消'}
          </button>
          <button
            className={cn('text-xs', danger ? 'btn-danger' : 'btn-primary')}
            onClick={() => settle(true)}
            data-confirm="ok"
          >
            {current.confirmLabel ?? '確定'}
          </button>
        </div>
      </div>
    </div>
  )
}
