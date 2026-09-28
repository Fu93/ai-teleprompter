import { describe, it, expect, vi } from 'vitest'
import { WhisperClient } from '../whisperClient'

/** 驗證 dispose() 會把在飛的 load() 一併 reject(原本永遠懸掛,await load() 的呼叫端卡死) */
describe('WhisperClient dispose', () => {
  it('dispose 後等待中的 load() 被 reject 而非懸掛', async () => {
    vi.useFakeTimers()
    const client = new WhisperClient()
    // stub worker:postMessage 後不回任何訊息 = 載入「卡住」的情境
    const fakeWorker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn()
    } as unknown as Worker
    ;(client as unknown as { worker: Worker })['worker'] = fakeWorker

    const loadPromise = client.load('base')
    // load 的 promise 已建立(掛在 fake worker 上等待 ready)
    await vi.advanceTimersByTimeAsync(0)

    const expectation = expect(loadPromise).rejects.toThrow('已釋放')
    client.dispose()
    await expectation
    vi.useRealTimers()
  })
})
