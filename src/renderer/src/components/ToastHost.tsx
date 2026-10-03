import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { AlertCircle, CheckCircle2, Info, Settings2, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { useToasts } from '../lib/toast'
import type { ToastAction, ToastKind } from '../lib/toast'
import { navigateTo } from '../lib/nav'

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

/**
 * 按下 action 鈕時做什麼。
 *
 * 宣告式的 action(來自 shared/errorCodes.ts)在這裡接上真正的副作用。
 * 放這裡而不是 errorCodes:那個檔案是**純資料**(main 也會 import),
 * 裡面出現 ipcRenderer.invoke 就等於把 renderer 的依賴漏進主進程。
 *
 * 'retry' 刻意不做任何事:錯誤碼表不允許呼叫端塞一個 callback 進來,
 * 而「重試」要重試的是呼叫端才知道的東西(重跑 getUserMedia?重打那個
 * AI 請求?)。這一輪的規則表沒有任何一條給出 'retry' —— 因為對使用者
 * 而言,「再按一次剛才那顆鈕」遠比「回到畫面自己再按」可靠。若之後真的有
 * 規則需要它,正確做法是讓呼叫端在 push 時自帶 onClick,而不是從這裡猜。
 */
function runAction(action: ToastAction, onDone: () => void): void {
  switch (action.kind) {
    case 'goto':
      if (action.page) {
        // 只有**真的換頁**才收起:被未存變更守衛攔下(使用者選「留在此頁」)時,
        // 這張卡片是這個錯誤唯一的下一步 —— 讓它先消失,使用者修完手上的事
        // 就再也回不到建議的那一步。同頁點擊算「已到達」(人已在目的地)。
        void navigateTo(action.page).then((ok) => {
          if (ok) onDone()
        })
        return
      }
      break
    case 'external':
    case 'docs':
      if (action.url) void window.api?.openExternal?.(action.url)
      break
    case 'retry':
      break
  }
  // 按下去就算「已處理」:無限期停駐的 toast 留在畫面上會擋住底下兩列清單
  // (domAudit 的 text-covered 會報),而使用者已經看到訊息並且已經出發去修了。
  // 對「重試」以外的動作尤其重要 —— 跳頁之後回來還看到同一張卡片,只會
  // 讓人懷疑剛才到底按了沒有。
  onDone()
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
    // items 只用來判斷空閒;tick/setPaused/dismiss 是 store 穩定引用。
    // (這裡曾經掛著一行 eslint-disable,但現行依賴列本來就完整 ——
    //  有了 lint 之後它變成一條「多餘的指示」而不是契約。)
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
      // toast 是**跨頁面的同一個元件**:不宣告範圍的話,它的「關閉通知」按鈕
      // 會被每一頁各算一顆控制項,覆蓋率對帳就再也不能回答「它驗過沒」。
      data-effect-scope="toast"
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
            <span className="min-w-0 flex-1 break-words text-xs leading-relaxed text-ink-100">
              {t.message}
              {t.action && (
                <button
                  type="button"
                  // 穩定身分:可及名稱含使用者可見的按鈕文字,而 action 的標籤
                  // 會隨錯誤碼改變(例如「前往設定」vs「下載 Ollama」)。
                  // 效果稽核需要穩定的 key,否則它每一輪都會變成未登記的新控制項。
                  data-effect-id="toast-action"
                  className="-mx-1.5 mt-1.5 flex h-7 items-center gap-1.5 rounded-lg px-1.5 text-[11px] text-accent-300 transition-colors hover:bg-white/10 hover:text-accent-200"
                  onClick={() => runAction(t.action!, () => dismiss(t.id))}
                >
                  <Settings2 size={12} />
                  {t.action.label}
                </button>
              )}
            </span>
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
