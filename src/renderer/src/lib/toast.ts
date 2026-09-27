/**
 * toast.ts — 全域 Toast 佇列(POLISH_RESEARCH P2-15)
 *
 * 規格:400ms ease 入場、4s 自動消失、hover 暫停、堆疊 scale 0.05 遞減。
 * Zustand store:任何模組 `toast.error('...')` 即可,不必接 props 或 context。
 *
 * 設計:
 * - 暫停以 remainingMs 記帳而非凍結 Date.now 差值,恢復時重設 deadline,簡單且可測
 * - 上限 3 則:超額時丟最舊的(最舊者多半已被看到)
 */

import { create } from 'zustand'

export type ToastKind = 'error' | 'success' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
  /** 剩餘顯示時間(ms);hover 暫停時凍結 */
  remainingMs: number
  /** false = 暫停中(hover) */
  running: boolean
}

const DISPLAY_MS = 4000
const MAX_VISIBLE = 3

interface ToastState {
  items: ToastItem[]
  push: (kind: ToastKind, message: string) => void
  dismiss: (id: number) => void
  /** hover 進入:凍結;離開:以剩餘時間繼續 */
  setPaused: (id: number, paused: boolean) => void
  /** 由 ToastHost 的單一 interval 週期性呼叫 */
  tick: (elapsedMs: number) => void
}

let nextId = 1

export const useToasts = create<ToastState>((set) => ({
  items: [],

  push: (kind, message) =>
    set((s) => {
      // 重複訊息不堆疊,重設計時(常見:同一錯誤連續觸發)
      const dupe = s.items.find((t) => t.message === message && t.kind === kind)
      if (dupe) {
        return {
          items: s.items.map((t) => (t.id === dupe.id ? { ...t, remainingMs: DISPLAY_MS, running: true } : t))
        }
      }
      const item: ToastItem = { id: nextId++, kind, message, remainingMs: DISPLAY_MS, running: true }
      const items = [item, ...s.items]
      // 上限 3 則,超額移除最舊(最舊者多半已被看到)
      return { items: items.length > MAX_VISIBLE ? items.slice(0, MAX_VISIBLE) : items }
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

export const toast = {
  error: (message: string): void => useToasts.getState().push('error', message),
  success: (message: string): void => useToasts.getState().push('success', message),
  info: (message: string): void => useToasts.getState().push('info', message)
}
