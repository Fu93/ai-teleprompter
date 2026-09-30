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

  it('Worker error 時 reject 在飛的 load 並清理壞掉的 worker', async () => {
    const listeners = new Map<string, (event: ErrorEvent) => void>()
    const fakeWorker = {
      addEventListener: vi.fn((type: string, listener: (event: ErrorEvent) => void) => {
        listeners.set(type, listener)
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type)
      }),
      postMessage: vi.fn(),
      terminate: vi.fn()
    } as unknown as Worker
    // WhisperClient 以 new Worker(...) 建構;箭頭函式不可被 new 建構,
    // 這裡若用 vi.fn(() => fakeWorker) 會丟 "is not a constructor"。
    // 必須用一般 function——constructor 回傳物件時,new 的結果即為該物件。
    vi.stubGlobal('Worker', vi.fn(function () { return fakeWorker }))
    // whisperClient 的 error handler 會做 instanceof ErrorEvent 判斷;node 測試環境
    // (vitest environment: 'node') 沒有這個全域,會在處理錯誤前先拋 ReferenceError,
    // 後面的 reject/清理根本走不到。這裡補上瀏覽器才有的全域。
    class FakeErrorEvent {
      message: string
      preventDefault = vi.fn()
      constructor(message: string) { this.message = message }
    }
    vi.stubGlobal('ErrorEvent', FakeErrorEvent)
    try {
      const client = new WhisperClient()
      const loadPromise = client.load('base')
      const expectation = expect(loadPromise).rejects.toThrow('worker crashed')
      // FakeErrorEvent 只實作了 error handler 真正會讀的欄位(message);
      // listener 的簽章宣告成 ErrorEvent,故轉型過去。
      listeners.get('error')?.(new FakeErrorEvent('worker crashed') as unknown as ErrorEvent)

      await expectation
      expect(client.isLoaded()).toBe(false)
      expect(fakeWorker.terminate).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
