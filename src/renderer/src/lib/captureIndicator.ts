/**
 * captureIndicator.ts — 錄音/錄影進行中的「環境指示」(docs/UX_FINDINGS.md P2 附錄 #1)。
 *
 * 問題:錄音中把主視窗最小化之後,「還在錄」這件事完全不可見 ——
 * 攝影機/麥克風指示燈在機殼上,工作列底下的視窗看起來與平時一樣。
 * 使用者要嘛一直惦記著、要嘛回來發現錄了兩小時的桌面音。
 *
 * 解法(縮小版,tray 圖示留獨立一輪):
 *   - 視窗標題:「● 錄音中 — AI 提詞機」——工作列預覽、Alt+Tab、標題列都讀得到
 *   - 工作列閃爍(flashFrame,由 main 端執行;macOS 降級為 dock 退避一次)
 *
 * 三個設計點:
 *   1. **owner 制而不是 boolean**:練習作答、講稿錄影、會議錄音都可能各自
 *      開著擷取。一個 boolean 會被後結束的那個清掉先結束的那個的指示。
 *   2. **有效狀態不變就不通知**:兩個 owner 都在錄時,清掉其中一個不該讓
 *      標題閃一次。比較前後摘要,相同就跳過(這也讓「重複 setState」不打 IPC)。
 *   3. **transport 可注入**:測試用假 transport 驅動,不必起 Electron。
 */
export interface CaptureIndicatorState {
  active: boolean
  /** 有效指示要顯示的完整標籤(例如「● 錄音中 — AI 提詞機」) */
  label: string
}

export type CaptureIndicatorTransport = (s: CaptureIndicatorState) => void

const DEFAULT_ACTIVE_LABEL = '● 錄音中 — AI 提詞機'
/** 還原值 = createMainWindow 的 title(見 src/main/windows.ts),兩處同字串 */
const DEFAULT_IDLE_LABEL = 'AI 提詞機'

const owners = new Map<string, string>()

function defaultTransport(s: CaptureIndicatorState): void {
  // document.title:工作列預覽與 Alt+Tab 讀的就是它,而且不依賴 IPC 是否通;
  // main 端的 setTitle/flashFrame 負責工作列閃爍(見 IPC.WindowCaptureIndicator)。
  if (typeof document !== 'undefined') document.title = s.active ? s.label : DEFAULT_IDLE_LABEL
  void window.api?.windowCaptureIndicator?.(s)
}

/** 目前所有 owner 合成出來的「有效狀態」(第一個 owner 的標籤就是顯示標籤) */
export function captureIndicatorSnapshot(): CaptureIndicatorState {
  const first = owners.values().next()
  return first.done ? { active: false, label: '' } : { active: true, label: first.value }
}

/**
 * 上報「我這個 owner 現在有/沒有在擷取」。label 為 null = 解除。
 * owner 例如 'record' / 'scripts-rec' / 'practice'。
 */
export function setCaptureIndicator(
  owner: string,
  label: string | null,
  transport: CaptureIndicatorTransport = defaultTransport
): void {
  const before = captureIndicatorSnapshot()
  if (label === null) owners.delete(owner)
  else owners.set(owner, label || DEFAULT_ACTIVE_LABEL)
  const after = captureIndicatorSnapshot()
  if (before.active === after.active && before.label === after.label) return
  transport(after)
}

/**
 * 全部解除(測試與「離頁前最後一道清理」用)。
 * 有 owner 才會送出通知:沒有在擷取時平白打一次 IPC 只會製造噪音。
 */
export function clearCaptureIndicators(transport: CaptureIndicatorTransport = defaultTransport): void {
  if (owners.size === 0) return
  owners.clear()
  transport({ active: false, label: '' })
}
