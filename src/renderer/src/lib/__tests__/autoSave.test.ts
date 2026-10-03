import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosave, AUTOSAVE_DELAY_MS } from '../autoSave'

describe('createAutosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('停止輸入後才寫入,而且是最後一次變動之後才寫', () => {
    const run = vi.fn()
    const a = createAutosave(AUTOSAVE_DELAY_MS, run)

    a.schedule()
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1)
    expect(run, '還沒到時間就不該寫入').not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  /**
   * 這是 debounce 存在的唯一理由:持續輸入不該讓寫入餓死。
   *
   * 反過來說,如果是 throttle/throttle 式寫入,打字的時候會不斷落盤 ——
   * 而每落盤一次就重建一次 db 寫入,是在使用者最不該被打擾的時候擾動他。
   */
  it('持續輸入不會讓寫入餓死,停止後仍會寫一次', () => {
    const run = vi.fn()
    const a = createAutosave(AUTOSAVE_DELAY_MS, run)

    for (let i = 0; i < 20; i++) {
      a.schedule()
      vi.advanceTimersByTime(400)
    }
    expect(run, '還在打字時不該寫入').not.toHaveBeenCalled()

    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    expect(run, '停止輸入後必須補上一次').toHaveBeenCalledTimes(1)
  })

  it('cancel 之後不會寫入(切換選取/卸載時不能把舊稿寫到新稿上)', () => {
    const run = vi.fn()
    const a = createAutosave(AUTOSAVE_DELAY_MS, run)

    a.schedule()
    a.cancel()
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 3)
    expect(run).not.toHaveBeenCalled()
  })

  it('cancel 之後再 schedule 仍然會寫入(cancel 不是永久停用)', () => {
    const run = vi.fn()
    const a = createAutosave(AUTOSAVE_DELAY_MS, run)

    a.cancel()
    a.schedule()
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    expect(run).toHaveBeenCalledTimes(1)
  })

  /**
   * 寫入失敗(磁碟滿)不能變成未處理的 promise rejection。
   *
   * 那會只留在 console 裡 —— 使用者看到的是「好像存了」,實際上沒有。
   * 這個模組不負責顯示錯誤,但它必須**不製造**比原本更糟的失敗型態。
   */
  it('寫入丟錯時不會產生未處理的 rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const a = createAutosave(AUTOSAVE_DELAY_MS, () => {
        throw new Error('磁碟滿')
      })
      a.schedule()
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('寫入回傳 promise 時也會被接住', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const a = createAutosave(AUTOSAVE_DELAY_MS, () => Promise.reject(new Error('寫入失敗')))
      a.schedule()
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
