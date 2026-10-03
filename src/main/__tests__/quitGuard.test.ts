import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQuitGuard, QUIT_FLUSH_TIMEOUT_MS } from '../quitGuard'

/**
 * 這些測試守的是一句話:**任何情況下都不能把退出卡住。**
 *
 * 為什麼用假 timer 而不是真的等:逾時路徑是這個模組裡最容易寫錯的一段,
 * 而它一旦寫錯,症狀是「使用者按更新之後電腦關不掉」——那是在別人電腦上
 * 才會發現的問題,所以在這裡把它釘死。
 */
function harness(opts: { recording?: boolean; flush?: () => Promise<unknown> } = {}) {
  const calls = {
    preventDefault: 0,
    markQuitting: 0,
    requestQuit: 0,
    logs: [] as string[]
  }
  const flush = opts.flush ?? vi.fn(async () => undefined)
  const guard = createQuitGuard({
    isRecording: () => opts.recording ?? true,
    flush,
    markQuitting: () => {
      calls.markQuitting++
    },
    requestQuit: () => {
      calls.requestQuit++
    },
    log: (m) => calls.logs.push(m)
  })
  const evt = { preventDefault: () => void calls.preventDefault++ }
  return { guard, calls, evt, flush }
}

describe('createQuitGuard — 沒在錄音時', () => {
  it('完全不擋,直接放行(不增加任何退出延遲)', () => {
    const { guard, calls, evt } = harness({ recording: false })
    guard.handleBeforeQuit(evt)
    expect(calls.preventDefault).toBe(0)
    expect(calls.requestQuit).toBe(0)
    expect(guard.state()).toBe('idle')
  })

  it('仍然要標記 quitting,讓視窗守衛讓路', () => {
    const { guard, calls, evt } = harness({ recording: false })
    guard.handleBeforeQuit(evt)
    expect(calls.markQuitting).toBe(1)
  })
})

describe('createQuitGuard — 錄音中收到退出請求', () => {
  it('擋下退出並開始存檔', () => {
    const { guard, calls, evt, flush } = harness()
    guard.handleBeforeQuit(evt)
    expect(calls.preventDefault).toBe(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(guard.state()).toBe('flushing')
  })

  it('存檔完成後才真的要求退出', async () => {
    // `let release!: () => void` 而不是 `let release: (() => void) | null`:
    // 後者會讓 TypeScript 把 release 收窄成 null(賦值發生在它看不見的
    // Promise 執行器裡),於是 `release()` 報 TS2349。
    let release!: () => void
    const { guard, calls, evt } = harness({
      flush: () =>
        new Promise<void>((r) => {
          release = r
        })
    })
    guard.handleBeforeQuit(evt)
    // 還沒存完時不得要求退出 —— 那會讓錄音資料被殺掉
    expect(calls.requestQuit).toBe(0)

    release()
    await vi.waitFor(() => expect(calls.requestQuit).toBe(1))
    expect(calls.markQuitting).toBe(1)
    expect(guard.state()).toBe('flushed')
  })

  it('自己的 requestQuit 引發的第二次 before-quit 必須放行(否則無限迴圈)', async () => {
    const { guard, calls, evt } = harness()
    guard.handleBeforeQuit(evt)
    await vi.waitFor(() => expect(guard.state()).toBe('flushed'))

    // 模擬 Electron:requestQuit → app.quit() → before-quit 再來一次
    const second = { preventDefault: () => void calls.preventDefault++ }
    guard.handleBeforeQuit(second)
    expect(calls.preventDefault).toBe(1) // 仍是第一次那 1 次,第二次沒有再擋
  })
})

describe('createQuitGuard — 絕對不能卡住退出', () => {
  it('存檔失敗:仍然退出,而且留下痕跡', async () => {
    const { guard, calls, evt } = harness({
      flush: async () => {
        throw new Error('IndexedDB 滿了')
      }
    })
    guard.handleBeforeQuit(evt)
    await vi.waitFor(() => expect(calls.requestQuit).toBe(1))
    expect(guard.state()).toBe('flushed')
    // 失敗必須被記下來,否則使用者下次看到少一場會議完全無從追查
    expect(calls.logs.join('\n')).toMatch(/失敗/)
    expect(calls.logs.join('\n')).toMatch(/IndexedDB 滿了/)
  })

  it('存檔卡住:逾時後仍然退出', async () => {
    vi.useFakeTimers()
    try {
      const { guard, calls, evt } = harness({
        flush: () => new Promise<void>(() => {}) // 永不 resolve
      })
      guard.handleBeforeQuit(evt)
      expect(calls.preventDefault).toBe(1)
      expect(calls.requestQuit).toBe(0)

      vi.advanceTimersByTime(QUIT_FLUSH_TIMEOUT_MS + 1)
      expect(calls.requestQuit).toBe(1)
      expect(guard.state()).toBe('flushed')
      expect(calls.logs.join('\n')).toMatch(/逾時/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('逾時之後才回應的 flush 不會二次觸發退出', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const { guard, calls, evt } = harness({
        flush: () =>
          new Promise<void>((r) => {
            release = r
          })
      })
      guard.handleBeforeQuit(evt)
      vi.advanceTimersByTime(QUIT_FLUSH_TIMEOUT_MS + 1)
      expect(calls.requestQuit).toBe(1)

      // 逾時之後 flush 才慢吞吞回來 —— 必須被忽略
      release()
      await vi.advanceTimersByTimeAsync(10)
      expect(calls.requestQuit).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('存檔中收到第二次退出請求(使用者改主意)不擋', async () => {
    const { guard, calls, evt } = harness({
      flush: () => new Promise<void>(() => {})
    })
    guard.handleBeforeQuit(evt)
    const second = { preventDefault: () => void calls.preventDefault++ }
    guard.handleBeforeQuit(second)
    expect(calls.preventDefault).toBe(1) // 第二次沒有 preventDefault
  })
})
