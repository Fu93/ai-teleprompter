/**
 * nav.ts — 「跳到某一頁」的小橋,給不是 React 元件的呼叫端用。
 *
 * 為什麼需要:
 *   頁面切換的權限在 `App.tsx` 的 `navigate()` 裡 —— 它帶著兩道守衛
 *   (講稿有未存變更、錄音/練習進行中),所以**不能**讓任何人繞過它直接 setPage。
 *   而這一輪要做的可行動錯誤裡,「前往設定」按鈕是按在全域 ToastHost 上的,
 *   那裡拿不到 App 的 props,也拿不到 navigate 函式。
 *
 *   兩種做法都被排除:
 *     1. 把 navigate 塞進 zustand store —— 守衛的邏輯就得搬到 store,而它
 *        依賴 `confirmDialog`(React 樹之外的 modal host)。能搬,但那是把
 *        「App 決定什麼時候能離開」變成「store 決定」,而 App 是唯一知道
 *        scriptsDirty 與 leaveGuard 的地方。
 *     2. 用 `location.hash = '#/settings'` —— hash 確實能換頁(初始 page
 *        狀態就是從 hash 讀的),但**會完全跳過兩道守衛**:講稿有未存變更時
 *        按「前往設定」就會靜默丟掉內容。這正是 App.navigate 存在的理由。
 *
 *   所以:App 啟動時把它的 navigate 登錄進來,ToastHost 呼叫 navigateTo()。
 *   守衛留在原地,只是多了一個合法入口。
 *
 * 沒登錄時的行為是**什麼都不做**,而不是拋錯:overlay 視窗也會 import 這支
 * 檔案(它沒有側欄、沒有 navigate),而它的 toast 由自己的體系處理。
 */

export type NavPage = 'dashboard' | 'scripts' | 'record' | 'practice' | 'calibration' | 'settings'

type Navigator = (page: NavPage) => void

let navigator: Navigator | null = null

/**
 * App 掛載時登錄自己的 navigate。
 *
 * 回傳退訂函式:StrictMode 會把 effect 跑兩次,而後一次掛載的 navigate 若沒有
 * 覆蓋掉先前的,登錄的就是一個已 unmount 的 setState —— 那不會立刻爆錯,
 * 它會安靜地讓按鈕失效。
 */
export function registerNavigator(fn: Navigator): () => void {
  navigator = fn
  return () => {
    if (navigator === fn) navigator = null
  }
}

/** 跳頁。沒有登錄 navigator 時安靜地不做(見檔頭)。 */
export function navigateTo(page: NavPage): void {
  navigator?.(page)
}
