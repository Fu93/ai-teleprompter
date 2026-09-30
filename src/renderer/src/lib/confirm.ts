/**
 * confirm.ts — App 內確認對話框的狀態源(Promise 化)。
 *
 * 為什麼要取代 window.confirm:
 *   原本七處(講稿未存變更的切換/捨棄/匯入、刪除講稿、刪除會議紀錄、
 *   刪除練習紀錄、側欄切頁)用的是系統原生對話框。它是作業系統畫的:
 *   不能套暗色主題、刪除這類破壞性動作沒有危險樣式、Esc 行為由系統決定、
 *   在 Electron 裡還會擋住整個視窗。使用者看到的是「Windows 灰白小視窗」
 *   插在一個精心調過的暗色介面中間。
 *
 * 為什麼用 Promise 而不是 state:
 *   呼叫端的寫法要能維持 `if (!(await confirmDialog(...))) return` 這種
 *   一眼看得懂的形式。同步的 window.confirm 可以無腦寫,改成 state 之後
 *   如果要求呼叫端自己串 callback,七處會各自長出不同的流程。
 *
 * 與 toast.ts / ToastHost.tsx 同一套分工:狀態在這裡,畫面在元件裡。
 */
import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  /** 補充說明:說清楚「會失去什麼」,而不只是「確定嗎」 */
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /** danger:刪除等不可復原的操作,確認鍵用紅色並預設焦點放在取消 */
  variant?: 'default' | 'danger'
}

interface PendingConfirm extends ConfirmOptions {
  id: number
  resolve: (ok: boolean) => void
}

interface ConfirmState {
  current: PendingConfirm | null
  /** 由 ConfirmHost 呼叫 */
  settle: (ok: boolean) => void
}

let nextId = 1

export const useConfirm = create<ConfirmState>((set, get) => ({
  current: null,

  settle: (ok) => {
    const cur = get().current
    if (!cur) return
    set({ current: null })
    cur.resolve(ok)
  }
}))

/**
 * 顯示確認對話框並等待使用者選擇。
 *
 * 同一時間只會有一個:第二次呼叫會先讓前一個以 false 結算(「取消」),
 * 避免前一個 Promise 永遠不 resolve 而把呼叫端的 await 卡住。
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const prev = useConfirm.getState().current
    if (prev) prev.resolve(false)
    useConfirm.setState({ current: { ...options, id: nextId++, resolve } })
  })
}
