import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { useToasts } from '../lib/toast'
import type { ToastKind } from '../lib/toast'

/**
 * ToastHost — 全域 toast 堆疊(POLISH_RESEARCH P2-15)
 *
 * 規格:400ms ease 入場、4s 自動消失、hover 暫停、堆疊 scale 0.05 遞減。
 * 掛載於 App 根層(主視窗);浮層有自己的 RescueCard 體系,不共用。
 */

const TICK_MS = 250

const KIND_META: Record<ToastKind, { icon: typeof Info; className: string }> = {
  error: { icon: AlertCircle, className: 'text-rose-450' },
  success: { icon: CheckCircle2, className: 'text-emerald-400' },
  info: { icon: Info, className: 'text-accent-300' }
}

export function ToastHost(): JSX.Element | null {
  const items = useToasts((s) => s.items)
  const tick = useToasts((s) => s.tick)
  const setPaused = useToasts((s) => s.setPaused)
  const dismiss = useToasts((s) => s.dismiss)
  const lastAtRef = useRef<number | null>(null)

  // 單一 interval 驅動所有 toast 的倒數;暫停中的項目由 store 端跳過
  useEffect(() => {
    lastAtRef.current = null
    const t = setInterval(() => {
      const now = Date.now()
      const last = lastAtRef.current ?? now
      lastAtRef.current = now
      if (items.length === 0) return
      tick(Math.min(1000, now - last))
    }, TICK_MS)
    return () => clearInterval(t)
    // items 只用來判斷空閒;tick/setPaused/dismiss 是 store 穩定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, items.length])

  if (items.length === 0) return null

  return (
    <div
      // z-[90] 而不是 z-50:必須高於 ConfirmDialog 的 z-[80]。
      // 那個確認對話框的遮罩是 bg-black/55 的滿版 fixed 元素,任何在它「開著的時候」
      // 發出的 toast(尤其是停留 12 秒的錯誤提示)都會被壓到陰影裡 —— 而「錯誤不能被
      // 錯過」正是把錯誤 toast 拉長停留的理由,被自己家的對話框蓋掉就白留了。
      // toastHostZClass 與 confirmDialogZClass 的關係由 toast-layering.test.ts 釘住。
      className="pointer-events-none fixed bottom-5 left-1/2 z-[90] flex -translate-x-1/2 flex-col-reverse items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {items.map((t, i) => {
        const meta = KIND_META[t.kind]
        const Icon = meta.icon
        return (
          <div
            key={t.id}
            // data-overlay-card:宣告「這個覆蓋是設計要的」。
            // 960×640(主視窗下限)時 bottom-center 的 toast 會壓住底下兩列列表的
            // 標題與日期,domAudit 的 text-covered 因此會報出來。判斷:這是
            // **暫時**且可關閉的(4 秒 / 錯誤 12 秒、hover 暫停、有 ✕),
            // 而且容器的 pointer-events-none 讓點擊直接穿透 —— 與模態遮罩同一類。
            // 若之後改成「toast 永久停駐」或「壓住的是使用者正在操作的東西」,
            // 這個宣告就該拿掉,而不是靠它把問題藏起來。
            data-overlay-card="1"
            className="toast-item glass pointer-events-auto flex w-[380px] max-w-[86vw] items-start gap-2.5 rounded-xl px-3.5 py-2.5"
            style={{ transform: `scale(${1 - i * 0.05})` }}
            onMouseEnter={() => setPaused(t.id, true)}
            onMouseLeave={() => setPaused(t.id, false)}
          >
            <Icon size={15} className={cn('mt-0.5 shrink-0', meta.className)} />
            <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-ink-100">{t.message}</span>
            <button
              // 28×28 命中區:原本是 `p-0.5` + 13px 圖示 = 17×17,遠低於 28px 的下限
              // (稽核的 small-tap-target 在每一個 toast 狀態都報到它)。
              // 圖示維持 13px 不變,只把命中區放大 —— 放大的視覺影響用 -mr 吸收,
              // 否則 toast 會整個變寬 11px,那是在改一個不是問題的版面。
              className="-mr-1.5 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-ink-400 transition-colors hover:bg-white/10 hover:text-white"
              onClick={() => dismiss(t.id)}
              title="關閉"
              aria-label="關閉通知"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
