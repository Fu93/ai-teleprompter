/**
 * historyWindow.ts — 歷史清單「一次載入 N 筆、可以再載入」的規則(純函式)。
 *
 * 為什麼需要它:
 *   會議紀錄原本只載最近 15 場、練習紀錄只載最近 10 筆 —— 沒有「載入更多」、
 *   畫面上也沒有任何說明。而總覽頁的「會議場數」用的是 count():數字寫著 42,
 *   清單裡只有 15 場,其餘 27 場**在 UI 裡根本到不了**。它與 HISTORY_CAP
 *   (Dashboard 的「數字看起來很正常,只是不再變了」)是同一族缺陷。
 *
 * 收斂成一處的理由:會議與練習兩個清單共用同一套規則,兩邊各寫一份的話,
 * 「一頁可以載入更多、另一頁不行」這種漂移遲早發生。
 */

/** 每按一次「再載入」多拿幾筆(首頁的初始筆數由各頁自己決定,歷史原因不同) */
export const HISTORY_WINDOW_STEP = 20

export interface HistoryWindow {
  /** 畫面上目前顯示幾筆 */
  shown: number
  /** 資料庫裡總共幾筆 */
  total: number
}

/** 按下「再載入」之後應該顯示幾筆(不會超過總數,也不會倒退) */
export function nextHistoryShown(
  shown: number,
  total: number,
  step: number = HISTORY_WINDOW_STEP
): number {
  return Math.min(Math.max(shown, 0) + Math.max(step, 0), Math.max(total, shown))
}

/**
 * 標題旁的筆數說明:「顯示最近 X 筆 / 共 Y 筆」。
 * 只在「還有沒顯示的」時出現 —— 全部都顯示了就不必解釋。
 */
export function historyCountLabel(win: HistoryWindow): string | null {
  return win.total > win.shown ? `顯示最近 ${win.shown} 筆 / 共 ${win.total} 筆` : null
}

/** 「再載入 N 筆」按鈕文字;沒有更多時回 null(按鈕不渲染) */
export function historyMoreLabel(
  win: HistoryWindow,
  step: number = HISTORY_WINDOW_STEP
): string | null {
  const remain = win.total - win.shown
  if (remain <= 0) return null
  return `再載入 ${Math.min(step, remain)} 筆`
}
