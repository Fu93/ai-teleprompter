import { describe, it, expect } from 'vitest'
import { describeError, isActionable } from '../describeError'

// 這組測試的價值在於「不要給錯誤的診斷」。
// 反例:Record 停止時原本把「辨識失敗」說成「沒有偵測到語音」,
// 使用者會跑去查麥克風硬體 —— 診斷錯了,代價是他的時間。
describe('describeError', () => {
  it('麥克風權限被拒:給出 Windows 設定路徑', () => {
    const e = new Error('Permission denied')
    e.name = 'NotAllowedError'
    const m = describeError(e)
    expect(m).toContain('權限')
    // 必須告訴他要去哪裡改,否則等於沒回答
    expect(m).toContain('隱私權')
  })

  it('跨 IPC 的錯誤只剩字串時仍能辨識(名字已遺失)', () => {
    expect(describeError('Permission denied')).toContain('權限')
    expect(describeError('NotAllowedError: Permission denied')).toContain('權限')
  })

  it('API 金鑰錯誤指向設定頁', () => {
    expect(describeError('401 Unauthorized')).toContain('API 金鑰')
    expect(describeError('Invalid API key provided')).toContain('API 金鑰')
  })

  it('Ollama 沒開時說明怎麼啟動', () => {
    const m = describeError('fetch failed')
    expect(m).toContain('Ollama')
    expect(m).toContain('ollama serve')
  })

  it('找不到麥克風與麥克風被占用是不同問題', () => {
    expect(describeError('NotFoundError: Requested device not found')).toContain('找不到')
    expect(describeError('NotReadableError: Could not start audio source')).toContain('占用')
  })

  it('不認得的錯誤回退到原文,不臆測診斷', () => {
    // 寧可顯示真實的英文原文,也不要自信地給錯的原因
    expect(describeError('Something totally unexpected happened')).toBe(
      'Something totally unexpected happened'
    )
  })

  it('認得的錯誤不會洩漏原始英文給使用者', () => {
    const e = new Error('Permission denied')
    e.name = 'NotAllowedError'
    const m = describeError(e)
    expect(m).not.toContain('Permission denied')
    expect(m).not.toContain('NotAllowedError')
  })

  it('isActionable 只對認得的錯誤為 true', () => {
    const e = new Error('Permission denied')
    e.name = 'NotAllowedError'
    expect(isActionable(e)).toBe(true)
    expect(isActionable('random failure')).toBe(false)
  })

  it('空值不會拋錯,給出可讀訊息', () => {
    expect(describeError(new Error(''))).toBe('發生未預期的錯誤')
  })
})
