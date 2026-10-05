// 貼鏡凝視錨點(DESIGN_RESEARCH P0-1)的決策邏輯。
//
// 為什麼是獨立的純函式檔:三個 IPC handler(snap / info / set)共用同一套
// 「錨點還有效嗎」的判斷,而這個判斷正是最容易悄悄漂移的部分 ——
// 拔螢幕、改解析度、錨點座標落在已不存在的螢幕上,每一種都要退回角落吸附
// 而不是把浮層停到錯的地方(台上的人看不到浮層 = 提詞機壞了)。
// 判斷寫在純函式裡,才能對每一條分支直接寫測試(gaze.test.ts)。
import { LENS_BAND_TOP_PX } from '@shared/overlayShapes'
import type { GazeAnchor, GazeInfo } from '@shared/types'

/**
 * Electron.Display 的結構子集:只要 id 與 bounds。
 * 用資料型別而不是 `import type { Display } from 'electron'` —— 測試傳平面物件
 * 就能驅動,不需要 mock 整個 electron 模組。
 */
export interface DisplayLike {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
}

/**
 * 錨點座標是否還落在「它自己那台螢幕」的範圍內(±40)。
 *
 * ±40 與 createOverlayWindow 還原上次座標的容差同一個數字:容差是為了
 * 「解析度微調後座標差了幾像素」這種無害情況,不是允許跨螢幕。
 * 超過容差代表這台螢幕的版面真的變了(改縮放/鏡射),舊錨點不可信。
 */
export function anchorOnDisplay(anchor: GazeAnchor, display: DisplayLike): boolean {
  const b = display.bounds
  return (
    anchor.x >= b.x - 40 &&
    anchor.x < b.x + b.width + 40 &&
    anchor.y >= b.y - 40 &&
    anchor.y < b.y + b.height + 40
  )
}

/** 錨點所屬螢幕;不在任何螢幕上(拔了)回 null。 */
export function findAnchorDisplay(anchor: GazeAnchor, displays: DisplayLike[]): DisplayLike | null {
  return displays.find((d) => d.id === anchor.displayId && anchorOnDisplay(anchor, d)) ?? null
}

/**
 * 停靠決策:snapOverlayGaze handler 的唯一判斷來源。
 *
 * - 'dock' — 錨點有效,moveTo(x, y)。
 * - 'fallback' — 退回「上中」角落;stale 區分兩種退回:
 *   stale:false = 從未校正(正常的第一天),stale:true = 校過但螢幕變了
 *   (設定頁要提示「重新校正」,而不是假裝一切正常)。
 */
export type GazeDockDecision =
  | { action: 'dock'; x: number; y: number }
  | { action: 'fallback'; stale: boolean }

export function resolveGazeDock(anchor: GazeAnchor | null, displays: DisplayLike[]): GazeDockDecision {
  if (!anchor) return { action: 'fallback', stale: false }
  const display = findAnchorDisplay(anchor, displays)
  if (!display) return { action: 'fallback', stale: true }
  return { action: 'dock', x: anchor.x, y: anchor.y }
}

/**
 * 設定頁狀態列的資料(角度在 renderer 端算)。
 *
 * offsetPx 的兩段:錨點座標距**螢幕物理上緣**(bounds.y,不是 workArea.y ——
 * 攝影機在螢幕上緣,工作區縮排是工作列的事,與鏡頭位置無關)的距離,
 * 加上文字帶頂緣在貼鏡視窗內的偏移(工具列 + pt + 上下文行,LENS_BAND_TOP_PX)。
 * 假設「攝影機 ≈ 螢幕物理上緣」與三顆角落吸附的設計前提同一條(見 OverlayApp
 * 「貼到螢幕上緣,離鏡頭軸線最近」)。
 */
export function gazeInfo(anchor: GazeAnchor | null, displays: DisplayLike[]): GazeInfo {
  if (!anchor) {
    return { anchored: false, stale: false, offsetPx: null, cameraLabel: null }
  }
  const display = findAnchorDisplay(anchor, displays)
  if (!display) {
    return { anchored: true, stale: true, offsetPx: null, cameraLabel: anchor.cameraLabel }
  }
  return {
    anchored: true,
    stale: false,
    offsetPx: anchor.y - display.bounds.y + LENS_BAND_TOP_PX,
    cameraLabel: anchor.cameraLabel
  }
}
