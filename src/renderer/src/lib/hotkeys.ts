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

/** 目前已註冊的解除函式;null = 未註冊 */
let unregisterBridge: (() => void) | null = null
/**
 * 稽核橋:強制一份衝突名單,讓「沒衝突的機器」也量得到「有衝突時的畫面」。
 *
 * ## 這裡修的是一個 StrictMode 造成的真實缺陷(2026-10-05)
 *
 * 原本這裡有一個 `bridgeInstalled` 布林,**而且從來沒有被設回 false**。在
 * `React.StrictMode` 下(這個專案有,見 main.tsx)開發模式的 effect 會:
 *
 *     掛載 → 註冊(bridgeInstalled = true)→ 清理(unregister 被呼叫,
 *     registry 裡的項目被刪掉)→ 再掛載(看到 bridgeInstalled === true,
 *     **直接 return 空函式,什麼都不註冊**)
 *
 * 結果是第二次掛載之後 `window.__auditForce('app.hotkeyConflicts', …)`
 * 完全失效 —— 稽核呼叫它時回 ok,但畫面上什麼都沒變。
 *
 * ## 這個 bug 曾經被誤判為 `hotkey-conflict-stale` 的根因(2026-10-05 更正)
 *
 * `audit:states` 長期的確報過那筆問題,症狀也一模一樣。但**根因是量測端**:
 * `audit-states.mjs` 清除畫面時傳的是 `null`,而 store 的讀法是
 * `forced ?? conflicts` —— `null` 是「解除覆寫、回到真實名單」。
 * 在這台真的被別的程式佔走 Alt+K 的機器上,警示如實長回來,於是量測端
 * 把自己的錯記成了產品的「過期警示缺陷」。
 * 修的是量測端(見 scripts/lib/hotkey-override.mjs),這個 StrictMode 的坑是
 * **另一件真的 bug**,只是碰巧有相同的症狀。記在這裡是因為教訓本身成立:
 * 「症狀吻合」不是「根因相同」的證據 —— 兩邊都修完之後症狀才會真的消失。
 *
 * ## 為什麼不用「先解除再註冊」
 *
 * 那樣會讓兩個同時掛載的 App 互相踢掉對方(浮層與主視窗各有一份 React 樹)。
 * 正確的形狀是「記住自己註冊的解除函式,重複呼叫時把前一份先解除」——
 * 這與 `lib/nav.ts` 的導航註冊是同一個模式,那裡的註解也記了同一個坑。
 */
export function installHotkeyConflictBridge(): () => void {
  // 已經註冊過一份:先解除,再重新註冊。否則第二次掛載拿到的是一份
  // 什麼都不做的清理函式,稽核橋就靜默失效了。
  unregisterBridge?.()
  unregisterBridge = registerAuditControl('app.hotkeyConflicts', (arg) => {
    if (arg === null || arg === undefined) {
      useHotkeyConflictStore.setState({ forced: null })
      return true
    }
    if (!Array.isArray(arg)) return false
    useHotkeyConflictStore.setState({ forced: arg.map(String) })
    return true
  })
  return () => {
    unregisterBridge?.()
    unregisterBridge = null
  }
}

/** 設定頁 / 側欄 / 總覽頁共用的讀取 hook */
export function useHotkeyConflicts(): string[] {
  return useHotkeyConflictStore((s) => s.forced ?? s.conflicts)
}
