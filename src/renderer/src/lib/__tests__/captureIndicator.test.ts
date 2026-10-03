/**
 * captureIndicator.test.ts — 錄音/錄影環境指示的狀態合成。
 *
 * 釘住三件事(都是「看起來會動、其實是壞的」的那類):
 *   1. owner 制:兩個擷取同時開著時,一個結束不能把另一個的指示清掉。
 *   2. 有效狀態不變就不通知:否則標題會無謂地閃、IPC 會無謂地打。
 *   3. 離頁/停止必還原(通知 active:false)。
 *
 * 負向驗證:把 setCaptureIndicator 的前後比較拿掉(無條件通知),
 * 第二條測試變紅;把 owner 制換成單一 boolean,第一條變紅。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  captureIndicatorSnapshot,
  clearCaptureIndicators,
  setCaptureIndicator,
  type CaptureIndicatorState
} from '../captureIndicator'

function recorder(): { calls: CaptureIndicatorState[]; transport: (s: CaptureIndicatorState) => void } {
  const calls: CaptureIndicatorState[] = []
  return { calls, transport: (s) => void calls.push({ ...s }) }
}

const noop = (): void => {}

beforeEach(() => clearCaptureIndicators(noop))

describe('captureIndicator', () => {
  it('開始擷取 → 通知 active + 標籤;解除 → 通知 inactive', () => {
    const { calls, transport } = recorder()
    setCaptureIndicator('record', '● 錄音中 — AI 提詞機', transport)
    expect(calls).toEqual([{ active: true, label: '● 錄音中 — AI 提詞機' }])
    setCaptureIndicator('record', null, transport)
    expect(calls[1]).toEqual({ active: false, label: '' })
  })

  it('兩個 owner:清掉其中一個不該把另一個的指示清掉,也不該重複通知', () => {
    const { calls, transport } = recorder()
    setCaptureIndicator('record', '● 錄音中 — AI 提詞機', transport)
    setCaptureIndicator('practice', '● 錄音中 — AI 提詞機', transport)
    // 同標籤:第二個 owner 不改變有效狀態 → 不通知
    expect(calls.length).toBe(1)
    setCaptureIndicator('practice', null, transport)
    // 顯示中的仍是 record → 不通知
    expect(calls.length).toBe(1)
    expect(captureIndicatorSnapshot().active).toBe(true)
    setCaptureIndicator('record', null, transport)
    expect(calls.length).toBe(2)
    expect(calls[1].active).toBe(false)
  })

  it('先結束的那個若正是顯示中的,標籤交棒給下一個 owner', () => {
    const { calls, transport } = recorder()
    setCaptureIndicator('record', '● 錄音中 — AI 提詞機', transport)
    setCaptureIndicator('scripts-rec', '● 錄影中 — AI 提詞機', transport)
    setCaptureIndicator('record', null, transport)
    expect(calls[calls.length - 1]).toEqual({ active: true, label: '● 錄影中 — AI 提詞機' })
  })

  it('重複上報同一個狀態不重複通知(重複 render 不打 IPC)', () => {
    const { calls, transport } = recorder()
    setCaptureIndicator('record', '● 錄音中 — AI 提詞機', transport)
    setCaptureIndicator('record', '● 錄音中 — AI 提詞機', transport)
    expect(calls.length).toBe(1)
  })

  it('空標籤退回預設標籤(不會把空字串設上視窗標題)', () => {
    const { calls, transport } = recorder()
    setCaptureIndicator('record', '', transport)
    expect(calls[0].label).toBe('● 錄音中 — AI 提詞機')
  })

  it('沒有任何 owner 時,clear 不平白通知', () => {
    const { calls, transport } = recorder()
    clearCaptureIndicators(transport)
    expect(calls.length).toBe(0)
    expect(captureIndicatorSnapshot()).toEqual({ active: false, label: '' })
  })
})
