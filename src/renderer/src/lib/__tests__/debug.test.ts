import { describe, it, expect, beforeEach } from 'vitest'
import {
  useDebug,
  debugLog,
  debugEnabled,
  formatDetail,
  buildDiagnostics,
  DEBUG_EVENT_LIMIT,
  type DebugEvent
} from '../debug'
import { DEFAULT_SETTINGS } from '@shared/types'

function reset(): void {
  useDebug.setState({
    enabled: false,
    panelOpen: false,
    paused: false,
    layout: { outline: false, hits: false, overflow: false, pick: false },
    events: []
  })
}

describe('debug store', () => {
  beforeEach(reset)

  it('未啟用時 debugLog 是 no-op(正式安裝包不付出成本)', () => {
    expect(debugEnabled()).toBe(false)
    debugLog('engine', '不會被記錄')
    expect(useDebug.getState().events).toHaveLength(0)
  })

  it('啟用後記錄事件,並保留 scope 與序列化後的 detail', () => {
    useDebug.getState().setEnabled(true)
    expect(debugEnabled()).toBe(true)
    debugLog('engine', '播放', { status: 'playing', elapsedMs: 1200 })
    const [ev] = useDebug.getState().events
    expect(ev.scope).toBe('engine')
    expect(ev.text).toBe('播放')
    expect(JSON.parse(ev.detail)).toEqual({ status: 'playing', elapsedMs: 1200 })
    expect(ev.at).toBeGreaterThan(0)
  })

  it('超過上限丟最舊的,總數固定', () => {
    useDebug.getState().setEnabled(true)
    for (let i = 0; i < DEBUG_EVENT_LIMIT + 50; i++) debugLog('engine', `evt-${i}`)
    const events = useDebug.getState().events
    expect(events).toHaveLength(DEBUG_EVENT_LIMIT)
    // 最舊的 50 筆被丟掉,第一筆應為 evt-50
    expect(events[0].text).toBe('evt-50')
    expect(events[events.length - 1].text).toBe(`evt-${DEBUG_EVENT_LIMIT + 49}`)
  })

  it('暫停時凍結事件流,恢復後繼續(要停下來細看某一筆就得能凍結)', () => {
    useDebug.getState().setEnabled(true)
    debugLog('engine', 'before')
    useDebug.getState().togglePaused()
    debugLog('engine', 'during')
    expect(useDebug.getState().events.map((e) => e.text)).toEqual(['before'])
    useDebug.getState().togglePaused()
    debugLog('engine', 'after')
    expect(useDebug.getState().events.map((e) => e.text)).toEqual(['before', 'after'])
  })

  it('版面開關彼此獨立切換', () => {
    useDebug.getState().toggleLayout('outline')
    useDebug.getState().toggleLayout('pick')
    expect(useDebug.getState().layout).toEqual({
      outline: true,
      hits: false,
      overflow: false,
      pick: true
    })
    useDebug.getState().toggleLayout('outline')
    expect(useDebug.getState().layout.outline).toBe(false)
  })

  it('clear 清空事件但保留開關狀態', () => {
    useDebug.getState().setEnabled(true)
    useDebug.getState().togglePanel()
    debugLog('engine', 'x')
    useDebug.getState().clear()
    expect(useDebug.getState().events).toHaveLength(0)
    expect(useDebug.getState().panelOpen).toBe(true)
    expect(useDebug.getState().enabled).toBe(true)
  })

  it('停用後不再記錄(dev 切回正式流程時不會偷偷累積)', () => {
    useDebug.getState().setEnabled(true)
    debugLog('engine', 'a')
    useDebug.getState().setEnabled(false)
    debugLog('engine', 'b')
    expect(useDebug.getState().events.map((e) => e.text)).toEqual(['a'])
  })
})

describe('formatDetail', () => {
  it('空值回空字串,字串原樣', () => {
    expect(formatDetail(undefined)).toBe('')
    expect(formatDetail(null)).toBe('')
    expect(formatDetail('already text')).toBe('already text')
  })

  it('Error 取 name+message(堆疊對除錯面板太長)', () => {
    expect(formatDetail(new TypeError('boom'))).toBe('TypeError: boom')
  })

  it('循環結構不拋錯,退回 String(工具自己丟錯最糟)', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => formatDetail(a)).not.toThrow()
    expect(formatDetail(a)).toBe('[object Object]')
  })
})

describe('buildDiagnostics', () => {
  it('產生可貼進 issue 的 JSON,且只帶最近 40 筆事件', () => {
    const events: DebugEvent[] = Array.from({ length: 60 }, (_, i) => ({
      at: 1_700_000_000_000 + i,
      scope: 'engine',
      text: `evt-${i}`,
      detail: ''
    }))
    const out = buildDiagnostics({
      app: { version: '0.2.0', platform: 'win32', userDataPath: 'C:/x', debug: true },
      settings: DEFAULT_SETTINGS,
      overlayInfo: { width: 720, height: 260 },
      overlaySnapshot: null,
      window: { width: 1180, height: 780, dpr: 1.25, hash: '#/debug' },
      events
    })
    const parsed = JSON.parse(out) as {
      app: { version: string }
      window: { dpr: number }
      recentEvents: Array<{ text: string; at: string }>
    }
    expect(parsed.app.version).toBe('0.2.0')
    expect(parsed.window.dpr).toBe(1.25)
    expect(parsed.recentEvents).toHaveLength(40)
    expect(parsed.recentEvents[0].text).toBe('evt-20')
    expect(parsed.recentEvents[39].text).toBe('evt-59')
    // 時間戳轉成可讀 ISO:貼給人看時不必自己換算 epoch
    expect(parsed.recentEvents[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})
