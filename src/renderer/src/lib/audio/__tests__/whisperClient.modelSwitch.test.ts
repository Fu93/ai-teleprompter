/**
 * 換語音模型的時序(與 whisperClient.test.ts 的 dispose 測試同族,但不同缺陷)。
 *
 * 為什麼這些測試要分一個檔:
 *   whisperClient.test.ts 驗的是「dispose 之後在飛的 load() 會落地」。
 *   這裡驗的是**換模型**時同一個保證 —— 而它原本不成立。
 *
 * ── 缺陷的樣子 ──
 *   load() 的第一個動作是覆寫 `this.loadPromise` 與 `this.rejectActiveLoad`。
 *   使用者在 base 下載到一半時把模型改成 small,第二次 load() 的指派讓第一次的
 *   rejecter 從此不可達 —— 第一個 promise 既不 resolve 也不 reject。
 *
 *   症狀與 dispose 那條一模一樣(按鈕永久停著、沒有錯誤訊息),但**原因不同**,
 *   而 dispose 的測試抓不到它:那條測試只呼叫 dispose(),從未中途換過 key。
 *
 * ── 這是使用者走得到的路徑 ──
 *   `await client.load(...)` 有三個呼叫端:開始聆聽(Record)、語音跟讀
 *   (useFollowMode)、個人化校準(Calibration)。而模型選擇器在設定頁,
 *   沒有任何地方把「換模型」變成要先停止這些操作的動作。
 */
import { describe, it, expect, vi } from 'vitest'
import { WhisperClient } from '../whisperClient'

/**
 * 回傳一個永遠不回訊息的假 worker —— 模擬「模型還在下載中」。
 * load() 在這種 worker 上會一直停在等待 ready 的狀態,正是缺陷發生的時機。
 */
function stubSilentWorker(client: WhisperClient): Worker {
  const fake = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    postMessage: vi.fn(),
    terminate: vi.fn()
  } as unknown as Worker
  ;(client as unknown as { worker: Worker })['worker'] = fake
  return fake
}

/** load() 是 async 方法,回傳的是包裝過的新 promise —— 身份比較沒有意義。 */
function loadPosts(worker: Worker): unknown[] {
  return (worker.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls
}

describe('WhisperClient 換模型', () => {
  it('換模型時在飛的舊 load() 被 reject,不永久懸掛', async () => {
    const client = new WhisperClient()
    stubSilentWorker(client)

    const first = client.load('base')
    // 在 base 還沒回 ready 時換成 small(使用者改設定)
    const second = client.load('small')

    // 關鍵斷言:第一個 promise 必須**落地**。修前它是懸空的 ——
    // await client.load() 的呼叫端(開始聆聽/跟讀/校準)會永遠卡在那一行。
    await expect(first).rejects.toThrow(/切換|已釋放|模型/)

    // 第二個仍是活的:它才是目前正要載入的那一個
    let secondSettled = false
    void second.then(
      () => {
        secondSettled = true
      },
      () => {
        secondSettled = true
      }
    )
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    client.dispose()
    await expect(second).rejects.toThrow()
  })

  it('換成同一個模型不會重新下載(既有行為不該被修壞)', async () => {
    const client = new WhisperClient()
    const worker = stubSilentWorker(client)

    const first = client.load('base')
    const again = client.load('base')
    void again.catch(() => undefined)

    // 斷言行為而不是 promise 身份:同一個 key 必須重用在下載中,
    // 否則會重複抓 145MB —— 而這正是 load() 的 loadedKey 快取存在的理由。
    const loads = loadPosts(worker).filter(
      (p) => (p as unknown as { type?: string }[])[0]?.type === 'load'
    )
    expect(loads).toHaveLength(1)

    client.dispose()
    await expect(first).rejects.toThrow()
  })

  it('晚到的舊世代 ready 不會讓已換掉的 load 再動一次', async () => {
    const client = new WhisperClient()
    const listeners: Array<(e: MessageEvent) => void> = []
    const fake = {
      addEventListener: vi.fn((_type: string, cb: (e: MessageEvent) => void) => listeners.push(cb)),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      terminate: vi.fn()
    } as unknown as Worker
    ;(client as unknown as { worker: Worker })['worker'] = fake

    const first = client.load('base')
    // 留住第一輪自己的 handler:worker 端 dispose/換模型不會真的把它從
    // 已派送的訊息佇列移除,所以它**確實**可能在換模型之後才被呼叫。
    const baseHandler = listeners[0]
    const second = client.load('small')

    baseHandler?.({ data: { type: 'ready', device: 'webgpu' } } as MessageEvent)

    // first 已經因為換模型被 reject;這次遲到的 ready 不能把它變回 resolved
    // (promise 一旦 settled 就不能改變,但它也**不能**去動屬於 small 的狀態)
    await expect(first).rejects.toThrow()

    client.dispose()
    await expect(second).rejects.toThrow()
  })
})
