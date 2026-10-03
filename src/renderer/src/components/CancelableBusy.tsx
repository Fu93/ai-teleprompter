/**
 * CancelableBusy.tsx — 長操作進行中的「取消」鈕。
 *
 * ── 為什麼需要 ──
 *   四個 AI 呼叫點(Practice 出題 / 逐題回饋 / 整體總評、Record 會議摘要)
 *   原本的主按鈕都是 `disabled={busy !== null}`,而 `ollamaAbort` 這條鏈路
 *   從一開始就完整卻**沒有任何呼叫端**。於是使用者按下之後只能等:
 *   雲端 provider 逾時 10 秒,本地 Ollama 首次回答常更久。
 *
 *   `GenerationGate` 能丟棄晚到的結果,但不能**終止**請求 —— 連線開著、
 *   雲端那邊仍在計費。而「按了沒反應」在這個專案裡被記錄過最貴的失敗模式之一。
 *
 * ── 為什麼是一個共用元件 ──
 *   四個呼叫點各寫一份的話,「取消之後要不要跳 toast」「要不要恢復 busy 狀態」
 *   這兩個決定會開始分歧 —— 那是這個專案記錄過的另一個教訓
 *   (見 scripts/audit-all.mjs 檔頭:同一件事寫兩次,兩邊會各自漂移)。
 *
 * ── 取消之後的語意 ──
 *   按下取消**不算錯誤**。不跳紅色 toast、不記 ai_request_failed 事件,
 *   只回到可操作的狀態。把「使用者自己按的取消」顯示成錯誤,是他唯一
 *   不會理解的畫面。
 */
import type { JSX, ReactNode } from 'react'

export interface CancelableBusyProps {
  /** 忙碌中且可取消 → 顯示取消鈕 */
  busy: boolean
  /** 正在進行、不可取消的操作(例如正在收帳 STT)→ 顯示但停用 */
  cancellable?: boolean
  onCancel: () => void
  /** 閒置時主按鈕的動作(忙碌中不提供這個 prop,因為那時不該能點) */
  onIdleClick?: () => void
  /** 忙碌中顯示的文字(例如「AI 出題中…」) */
  busyLabel: ReactNode
  /** 閒置時顯示的文字 */
  idleLabel: ReactNode
  disabled?: boolean
  className?: string
  title?: string
}

export function CancelableBusy({
  busy,
  cancellable = true,
  onCancel,
  onIdleClick,
  busyLabel,
  idleLabel,
  disabled = false,
  className = 'btn-primary w-full',
  title
}: CancelableBusyProps): JSX.Element {
  if (!busy) {
    return (
      <button type="button" className={className} onClick={onIdleClick} disabled={disabled} title={title}>
        {idleLabel}
      </button>
    )
  }
  return (
    <div className="flex w-full gap-2">
      <button type="button" className={className} disabled title={title}>
        {busyLabel}
      </button>
      <button
        type="button"
        className="btn-secondary shrink-0"
        onClick={onCancel}
        disabled={!cancellable}
        title={
          cancellable
            ? '中止這次 AI 請求(已經送出的部分不會計回來,但不會繼續等)'
            : '這段期間無法取消'
        }
      >
        取消
      </button>
    </div>
  )
}
