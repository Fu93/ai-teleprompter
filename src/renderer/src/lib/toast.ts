/**
 * toast.ts — 全域 Toast 佇列(POLISH_RESEARCH P2-15)
 *
 * 規格:400ms ease 入場、4s 自動消失、hover 暫停、堆疊 scale 0.05 遞減。
 * Zustand store:任何模組 `toast.error('...')` 即可,不必接 props 或 context。
 *
 * 設計:
 * - 暫停以 remainingMs 記帳而非凍結 Date.now 差值,恢復時重設 deadline,簡單且可測
 * - 上限 3 則:超額時丟最舊的(最舊者多半已被看到)
 *
 * ── action 欄位(這一輪新增) ──
 *   原本 `push(kind, message)` 只能帶一句話,所以「可行動」這件事在資料結構
 *   層面就不可能:錯誤訊息再怎麼寫得溫和,使用者能做的仍然只有「看著它消失」。
 *
 *   有 action 的 toast **不自動消失**。理由與錯誤停留 12 秒是同一個:
 *   看到「麥克風權限被拒」之後要做的是離開 App 去 Windows 設定改權限再回來。
 *   如果按鈕在 12 秒後連同整張卡片一起消失,那顆按鈕存在的意義只有 12 秒。
 *   非 action 的錯誤維持 12 秒(無限期停駐的錯誤會把畫面蓋住,那更糟)。
 */

import { create } from 'zustand'

export type ToastKind = 'error' | 'success' | 'info'

/** toast 上的下一步按鈕。宣告式:執行期由 ToastHost 依 kind 決定怎麼做。 */
export interface ToastAction {
  label: string
  /**
   * 按下去要做什麼。
   *
   * 用 kind 而不是直接放 callback,是因為**錯誤碼表是純資料**(shared/errorCodes.ts
   * 被 main 也會 import),不能在那裡放函式。真正的副作用(跳頁、開瀏覽器)
   * 在 ToastHost 一側接起來,新增一種目的地只需要改那裡一處。
   */
  kind: 'retry' | 'goto' | 'external' | 'docs'
  /** kind==='goto' 的目的頁 */
  page?: 'settings' | 'record' | 'practice' | 'scripts'
  /** kind==='external' / 'docs' 的網址 */
  url?: string
}

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
  /** 剩餘顯示時間(ms);hover 暫停時凍結 */
  remainingMs: number
  /** false = 暫停中(hover) */
  running: boolean
  /** 可選的下一步按鈕 */
  action?: ToastAction
}

const DISPLAY_MS = 4000
/**
 * 錯誤停留更久。使用者看到「麥克風權限被拒」之後要做的是離開 App 去 Windows
 * 設定改權限再回來 —— 4 秒不夠他讀完一句話。成功/資訊是「已經好了」的告知,
 * 4 秒合理;錯誤是「你要去做點什麼」,所以加長。
 */
const ERROR_DISPLAY_MS = 12_000
const MAX_VISIBLE = 3

interface ToastState {
  items: ToastItem[]
  push: (kind: ToastKind, message: string, action?: ToastAction) => void
  dismiss: (id: number) => void
  /** hover 進入:凍結;離開:以剩餘時間繼續 */
  setPaused: (id: number, paused: boolean) => void
  /** 由 ToastHost 的單一 interval 週期性呼叫 */
  tick: (elapsedMs: number) => void
}

let nextId = 1

/**
 * 有 action 的 toast 不自動消失。
 *
 * 實作方式是 remainingMs = Infinity,而 tick 的倒數迴圈用 `remaining - elapsed`
 * 計算:Infinity - elapsed 仍然是 Infinity,`if (remaining > 0)` 恆成立 ——
 * 也就是說不需要在 tick 裡加任何分支,倒數機制自己就會跳過它。
 *
 * 這不是巧合而是刻意的:若改成用一個 boolean 旗標,`tick` 就得多問一次
 * 「這張卡片要不要倒數」,而那個問題的答案分散在兩處(這裡與 push 裡),
 * 遲早會有一張卡片兩邊說法不一致 —— 症狀是按鈕還在、計時卻已經在跑。
 */
const NO_EXPIRY = Number.POSITIVE_INFINITY

export const useToasts = create<ToastState>((set) => ({
  items: [],

  push: (kind, message, action) =>
    set((s) => {
      const displayMs = kind === 'error' ? ERROR_DISPLAY_MS : DISPLAY_MS
      const remainingMs = action ? NO_EXPIRY : displayMs
      // 重複訊息不堆疊,重設計時(常常:同一錯誤連續觸發)
      // 連 action 也要比:同一個錯誤第二次帶著按鈕進來,若只比對訊息,
      // 會被當成同一則而只更新計時 —— 舊的那張(可能沒有按鈕)會留在畫面上,
      // 使用者看到的是「這次沒有下一步可按」。
      const dupe = s.items.find(
        (t) => t.message === message && t.kind === kind && sameAction(t.action, action)
      )
      if (dupe) {
        return {
          items: s.items.map((t) => (t.id === dupe.id ? { ...t, remainingMs, running: true } : t))
        }
      }
      const item: ToastItem = { id: nextId++, kind, message, remainingMs, running: true }
      if (action) item.action = action
      const items = [item, ...s.items]
      if (items.length <= MAX_VISIBLE) return { items }
      // 上限 3 則。超額時先淘汰「會自動消失」的項目:帶按鈕的錯誤不會自己退場
      // (它是使用者唯一的下一步),被第四則訊息靜默擠掉的話,使用者還沒走到
      // 按鈕前面它就沒了。注意 items 是新在前,所以從尾端找最舊的非 action 項;
      // 全部都不會過期時才退最舊。
      let evictIdx = items.length - 1
      for (let i = items.length - 1; i >= 0; i--) {
        if (!items[i].action) {
          evictIdx = i
          break
        }
      }
      return { items: items.filter((_, i) => i !== evictIdx) }
    }),

  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),

  setPaused: (id, paused) =>
    set((s) => ({
      items: s.items.map((t) => (t.id === id ? { ...t, running: !paused } : t))
    })),

  tick: (elapsedMs) =>
    set((s) => {
      const next: ToastItem[] = []
      let changed = false
      for (const t of s.items) {
        if (!t.running) {
          next.push(t)
          continue
        }
        changed = true // 有運行中的項目:遞減即為狀態變更
        const remaining = t.remainingMs - elapsedMs
        if (remaining > 0) next.push({ ...t, remainingMs: remaining })
        // remaining <= 0:到期,不移入 next
      }
      return changed ? { items: next } : s
    })
}))

/** 兩顆 action 鈕算不算「同一個」:逐欄位比,因為它都是純資料。 */
function sameAction(a: ToastAction | undefined, b: ToastAction | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.label === b.label && a.page === b.page && a.url === b.url
}

export const toast = {
  error: (message: string, action?: ToastAction): void => useToasts.getState().push('error', message, action),
  success: (message: string): void => useToasts.getState().push('success', message),
  info: (message: string): void => useToasts.getState().push('info', message)
}
