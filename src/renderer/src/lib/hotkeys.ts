/**
 * hotkeys.ts — 「哪些全域熱鍵根本沒註冊成功」的單一出處。
 *
 * 為什麼要抽出來(原本這個 effect 長在 SettingsPage 裡):
 *
 *   同一份邏輯現在有三個使用端 —— 設定頁(逐顆列出 + 反查功能)、側欄提示、
 *   總覽頁的熱鍵 footer。這個專案的教訓是同一份判斷寫兩份一定會漂移:
 *   側欄原本**只讀設定值、不讀衝突**,於是一顆註冊失敗的電腦上,側欄白紙黑字
 *   寫著 `Ctrl+Alt+T 顯示 / 隱藏浮層`,而它按下去什麼都不發生 ——
 *   一個畫面在承諾,另一個畫面在道歉,而使用者只看得到第一個。
 *
 * 新鮮度(為什麼不是 mount 讀一次)沿用設定頁原本的結論:main 是在
 * `SettingsSet` 之後才重新註冊熱鍵的,所以衝突是「使用者改完之後」才發生;
 * 立刻去問會拿到舊名單,而**過期的警告比沒有警告更糟** —— 它讓人去查一個
 * 已經修好的問題。延遲 400ms 是給 unregisterAll + 重新註冊六顆 OS 層熱鍵
 * 的時間;依賴寫 hotkeys 物件參考(deepMerge 只在真的動到該鍵時才換參考),
 * 所以拖字級滑桿不會平白多打一次 IPC。
 */
import { create } from 'zustand'
import { registerAuditControl } from './auditBridge'

interface HotkeyConflictStore {
  /** main 回報的真實衝突 */
  conflicts: string[]
  /**
   * 稽核強制值。非 null 時覆蓋 conflicts —— 沒有它的話,「有衝突時側欄必須
   * 告知」這條規則在乾淨的 CI 上永遠驗不到(那裡一顆衝突都不會有),
   * 而一條永遠不會變紅的規則等於沒有規則。
   */
  forced: string[] | null
}

export const useHotkeyConflictStore = create<HotkeyConflictStore>(() => ({
  conflicts: [],
  forced: null
}))

/** 目前應該顯示的衝突名單(稽核覆寫優先)。給非 React 使用端(e2e / 稽核)讀。 */
export function currentHotkeyConflicts(): string[] {
  const s = useHotkeyConflictStore.getState()
  return s.forced ?? s.conflicts
}

/**
 * 主視窗掛一次的 watcher:掛載 + 每次被重新呼叫後 400ms 各問一次 main。
 * 回傳解除訂閱函式。
 *
 * 為什麼沒有參數:新鮮度是**呼叫端的責任** —— 呼叫端把它放在
 * `useEffect(() => watchHotkeyConflicts(), [settings?.hotkeys])` 裡,
 * 物件參考只在熱鍵真的被改到時才換,所以拖字級滑桿不會平白多打一次 IPC。
 * 這裡若收一個不使用的參數,lint 會正確地把它標成未使用,而「用來當依賴
 * 卻不使用」正是那條規則要抓的東西。
 */
export function watchHotkeyConflicts(): () => void {
  let alive = true
  const load = (): void => {
    void window.api
      .appInfo()
      .then((info) => {
        if (alive) useHotkeyConflictStore.setState({ conflicts: info.hotkeyConflicts ?? [] })
      })
      .catch(() => {
        if (alive) useHotkeyConflictStore.setState({ conflicts: [] })
      })
  }
  load()
  const id = setTimeout(load, 400)
  return () => {
    alive = false
    clearTimeout(id)
  }
}

let bridgeInstalled = false
/** 稽核橋:強制一份衝突名單,讓「沒衝突的機器」也量得到「有衝突時的畫面」 */
export function installHotkeyConflictBridge(): () => void {
  if (bridgeInstalled) return () => undefined
  bridgeInstalled = true
  return registerAuditControl('app.hotkeyConflicts', (arg) => {
    if (arg === null || arg === undefined) {
      useHotkeyConflictStore.setState({ forced: null })
      return true
    }
    if (!Array.isArray(arg)) return false
    useHotkeyConflictStore.setState({ forced: arg.map(String) })
    return true
  })
}

/** 設定頁 / 側欄 / 總覽頁共用的讀取 hook */
export function useHotkeyConflicts(): string[] {
  return useHotkeyConflictStore((s) => s.forced ?? s.conflicts)
}
