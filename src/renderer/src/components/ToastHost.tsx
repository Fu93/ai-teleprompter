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
      className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col-reverse items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {items.map((t, i) => {
        const meta = KIND_META[t.kind]
        const Icon = meta.icon
        return (
          <div
            key={t.id}
            className="toast-item glass pointer-events-auto flex w-[380px] max-w-[86vw] items-start gap-2.5 rounded-xl px-3.5 py-2.5"
            style={{ transform: `scale(${1 - i * 0.05})` }}
            onMouseEnter={() => setPaused(t.id, true)}
            onMouseLeave={() => setPaused(t.id, false)}
          >
            <Icon size={15} className={cn('mt-0.5 shrink-0', meta.className)} />
            <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-ink-100">{t.message}</span>
            <button
              className="shrink-0 cursor-pointer rounded p-0.5 text-ink-400 transition-colors hover:bg-white/10 hover:text-white"
              onClick={() => dismiss(t.id)}
              title="關閉"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
