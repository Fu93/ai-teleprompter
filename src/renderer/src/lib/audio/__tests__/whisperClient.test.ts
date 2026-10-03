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

/**
 * 看門狗:worker 活著但不回應時會發生什麼。
 *
 * 這是「使用者講了整場、逐字稿一片空白、而且沒有任何錯誤」的成因 —— pending
 * 裡那一筆永遠不 settle,`chain` 又讓後面每一段都排在它後面等下去。
 *
 * 測試手法上兩個坑(都踩過,寫在這裡免得下次再花時間):
 *   1. fake worker 是**直接注入** client['worker'] 的,所以 ensureWorker() 會
 *      早退 —— 它從來沒有替我們註冊 message 監聽器。要餵回覆只能呼叫 client
 *      的 handle(),走 worker 事件反而沒有東西會收。
 *   2. transcribe() 透過 chain.then 排隊,所以要**先推進 0 毫秒**讓那段被建立、
 *      計時器被掛上,再推進 1_000 毫鐘;直接推進 1_000 的話,計時器是在推進
 *      結束後才建立的,永遠等不到它。
 */
describe('WhisperClient 看門狗', () => {
  /** 直接注入一個永不回覆的 worker(負載已完成、推論卡死)。 */
  function stuckClient(timeoutMs = 1_000): {
    client: WhisperClient
    posted: Array<{ id: number }>
    reply: (id: number | undefined, text: string) => void
  } {
    const posted: Array<{ id: number }> = []
    const fakeWorker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn((msg: { id?: number }) => {
        if (typeof msg?.id === 'number') posted.push({ id: msg.id })
      }),
      terminate: vi.fn()
    } as unknown as Worker
    const client = new WhisperClient({ transcribeTimeoutMs: timeoutMs })
    ;(client as unknown as { worker: Worker })['worker'] = fakeWorker
    return {
      client,
      posted,
      reply: (id, text) =>
        (client as unknown as { handle: (m: unknown) => void }).handle({ type: 'result', id, text })
    }
  }

  it('逾時會 reject 該段、發出狀態訊息,而且**不會**讓後續請求一起卡死', async () => {
    vi.useFakeTimers()
    const { client, posted, reply } = stuckClient()
    const statuses: string[] = []
    client.onStatus = (m) => statuses.push(m)

    // load() 不會回 ready,但它會把 loadPromise 設成非 null —— 這正是「已載入但
    // 推論卡住」的樣態。
    void client.load('base').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    const first = client.transcribe(new Float32Array(160), 'zh')
    await vi.advanceTimersByTimeAsync(0) // 讓這一段真的排進 chain、計時器掛上
    const rejected = expect(first).rejects.toThrow('語音辨識逾時')
    await vi.advanceTimersByTimeAsync(1_000)
    await rejected
    expect(statuses.join()).toContain('語音辨識沒有回應')

    // 關鍵:watchdog 之後 chain 必須能往前走。第二段照樣送出,而且給它回覆就會 resolve。
    const second = client.transcribe(new Float32Array(160), 'zh')
    await vi.advanceTimersByTimeAsync(0)
    const secondId = posted[posted.length - 1]?.id
    expect(secondId).toBeDefined()
    reply(secondId, '回來了')
    await expect(second).resolves.toBe('回來了')
    vi.useRealTimers()
  })

  it('正常回覆時不留逾時計時器(否則長會議會累積幾百個 90 秒後才觸發的計時器)', async () => {
    vi.useFakeTimers()
    const { client, posted, reply } = stuckClient()
    void client.load('base').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    const p = client.transcribe(new Float32Array(160), 'zh')
    await vi.advanceTimersByTimeAsync(0)
    reply(posted[posted.length - 1]?.id, '好的')
    await expect(p).resolves.toBe('好的')

    // 若計時器沒被清掉,再走 5 秒就會觸發逾時分支(onStatus 被呼叫)
    const statuses: string[] = []
    client.onStatus = (m) => statuses.push(m)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(statuses).toHaveLength(0)
    vi.useRealTimers()
  })
})
