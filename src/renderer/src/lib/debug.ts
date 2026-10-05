/**
 * debug.ts — 開發者除錯層的單一狀態源(UI/UX debug 支援)。
 *
 * 為什麼需要這一層:
 *   這個專案的 UI bug 幾乎都出在「執行期狀態」而不是靜態版面 —— 引擎跑到第幾句、
 *   跟讀對位到哪個 chunk、教練與 turn-yield 事件何時真的觸發、校準後的 1× 實際等於
 *   多少倍率。這些截圖看不出來,離線稽核也測不到(得真的開一場會議)。
 *   於是修 bug 只能「改一行 → 重建 → 再試一次」,而浮層還是獨立置頂視窗,
 *   連 DevTools 都打不開。
 *
 * 設計原則:
 * - 這個 store 不碰 DOM:node 環境可直接單元測試,「未啟用即 no-op」的 gating 也測得到。
 * - 未啟用時 debugLog 是 no-op —— 正式安裝包不付出任何成本,也不會有事件累積。
 * - 事件留環形緩衝上限,面板開著跑一整天也不會吃光記憶體。
 */

import { create } from 'zustand'
import type { AppSettings } from '@shared/types'

/** 事件流上限:超過就丟最舊的 */
export const DEBUG_EVENT_LIMIT = 200

export interface DebugEvent {
  at: number
  scope: string
  text: string
  detail: string
}

/**
 * 版面除錯開關:
 * - outline:所有元素外框(看排版與巢狀結構)
 * - hits:低於 28px 的命中區標紅(這個專案修過好幾次點不到的控制項)
 * - overflow:被非捲動容器裁掉的元素標橙(浮層工具列溢出就是這個型態)
 * - pick:游標檢視器,顯示游標下元素的 tag/class/rect/color
 */
export type LayoutDebugKey = 'outline' | 'hits' | 'overflow' | 'pick'

export const LAYOUT_DEBUG_KEYS: readonly LayoutDebugKey[] = ['outline', 'hits', 'overflow', 'pick']

export const LAYOUT_DEBUG_LABEL: Record<LayoutDebugKey, string> = {
  outline: '元素外框',
  hits: '過小命中區',
  overflow: '被裁切內容',
  pick: '游標檢視器'
}

interface DebugState {
  enabled: boolean
  panelOpen: boolean
  paused: boolean
  layout: Record<LayoutDebugKey, boolean>
  events: DebugEvent[]
  setEnabled: (v: boolean) => void
  togglePanel: () => void
  toggleLayout: (k: LayoutDebugKey) => void
  togglePaused: () => void
  push: (scope: string, text: string, detail?: unknown) => void
  clear: () => void
}

/**
 * detail 可能是任何東西(Error、DOM 元素、循環結構)。
 * 序列化失敗一律退回 String:除錯工具自己丟錯是最糟的體驗,
 * 尤其它常常是唯一能用的工具。
 */
export function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return ''
  if (typeof detail === 'string') return detail
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export const useDebug = create<DebugState>((set) => ({
  enabled: false,
  panelOpen: false,
  paused: false,
  layout: { outline: false, hits: false, overflow: false, pick: false },
  events: [],

  setEnabled: (v) => set({ enabled: v }),

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  toggleLayout: (k) => set((s) => ({ layout: { ...s.layout, [k]: !s.layout[k] } })),

  togglePaused: () => set((s) => ({ paused: !s.paused })),

  push: (scope, text, detail) =>
    set((s) => {
      // 未啟用或已暫停:整筆丟棄。暫停是刻意的 ——
      // 事件流在捲動時會一直跳,要停下來細看某一筆就得能凍結。
      if (!s.enabled || s.paused) return s
      const ev: DebugEvent = { at: Date.now(), scope, text, detail: formatDetail(detail) }
      const next = [...s.events, ev]
      return {
        events: next.length > DEBUG_EVENT_LIMIT ? next.slice(next.length - DEBUG_EVENT_LIMIT) : next
      }
    }),

  clear: () => set({ events: [] })
}))

/** 給不需要 React 的地方(事件回呼、音訊管線、條件式成本判斷)用 */
export function debugEnabled(): boolean {
  return useDebug.getState().enabled
}

/** 記一筆除錯事件。未啟用/已暫停即 no-op。 */
export function debugLog(scope: string, text: string, detail?: unknown): void {
  useDebug.getState().push(scope, text, detail)
}

/**
 * 訂閱 main 廣播的即時訊號,寫進事件流。
 *
 * 「該你說話了 / 教練提示 / 救援卡」是本專案最難人工重現的 UI(需要真的開一場會議,
 * 而且教練訊號各有 120–300 秒冷卻)。有了事件流,至少能看到它們何時、帶什麼 payload
 * 進來;搭配 debugEmitSignal 就能主動重現。
 *
 * 未啟用時回傳 no-op,呼叫端不必自己判斷。
 */
export function subscribeDebugSignals(): () => void {
  if (typeof window === 'undefined' || !window.api) return () => undefined
  const offs: Array<() => void> = [
    window.api.onTurnYield((p) => debugLog('turn-yield', p.kind, { question: p.question })),
    window.api.onCoaching((p) => debugLog('coaching', p.message, { kind: p.kind })),
    // 瞬時節奏是**讀數**:每 ~2 秒一次心跳。整條寫進事件流會把其他訊號洗掉,
    // 所以只記「判定或數字變了」的那幾筆(含回到窗內語音不足)。
    ((): (() => void) => {
      let seen = 'init'
      return window.api.onCoachingPace((p) => {
        const key = p.cpm === null ? 'none' : `${p.cpm}:${p.verdict}`
        if (key === seen) return
        seen = key
        debugLog(
          'pace',
          p.cpm === null ? '瞬時語速:窗內語音不足' : `${p.cpm} 字/分(${p.verdict})`,
          { baseline: p.baseline }
        )
      })
    })(),
    window.api.onPanicRescue((p) =>
      debugLog('panic', `${p.source} / 信心 ${p.confidence.toFixed(2)}`, {
        sentence: p.sentence,
        points: p.points
      })
    ),
    window.api.onPanicError((m) => debugLog('panic-error', m)),
    window.api.onSettingsChanged((s) =>
      debugLog('settings', `${s.overlay.displayMode} · ${s.overlay.rate}× · ${s.overlay.speed}px/s`)
    ),
    window.api.onOverlayVisibility((v) => debugLog('overlay', v ? '浮層顯示' : '浮層隱藏'))
  ]
  return () => offs.forEach((off) => off())
}

export interface DiagnosticsInput {
  app: { version: string; platform: string; userDataPath: string; debug: boolean } | null
  settings: AppSettings | null
  overlayInfo: unknown
  overlaySnapshot: unknown
  window: { width: number; height: number; dpr: number; hash: string }
  events: DebugEvent[]
}

/**
 * 產生可貼進 issue 的診斷 JSON。
 * 刻意包含「最近的除錯事件」:UI 問題的現場往往在錯誤發生前幾秒的事件裡。
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const payload = {
    generatedAt: new Date().toISOString(),
    app: input.app,
    window: input.window,
    overlayInfo: input.overlayInfo,
    overlaySnapshot: input.overlaySnapshot,
    settings: input.settings,
    recentEvents: input.events.slice(-40).map((e) => ({
      at: new Date(e.at).toISOString(),
      scope: e.scope,
      text: e.text,
      detail: e.detail
    }))
  }
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}
