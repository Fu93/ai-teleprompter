/**
 * aiAbort.test.ts — 在飛 AI 請求的取消登錄表。
 *
 * ── 這條測試要擋住的具體失效 ──
 *   `ollamaAbort` 這條鏈路從一開始就是完整的(handler、preload、簽章、
 *   ollama.ts 裡正確的 abort 處理),而**沒有任何呼叫端**。於是四個 AI
 *   呼叫點的主按鈕都是 `disabled={busy !== null}`,使用者只能等。
 *
 *   這個登錄表是修正的核心:它讓取消真的發生在 fetch 上,而不只是讓 UI
 *   假裝不再等待。而「按了取消但請求還在跑」正是那種看起來修好了的失效 ——
 *   GenerationGate 能丟棄晚到的結果,但連線開著、雲端仍在計費。
 *
 *   另一個必須測的:`releaseRequest` 沒被呼叫時,map 會隨每一次 AI 呼叫
 *   單調成長。它是 module 級的,撐到 app 結束 —— 長時間使用的機器上
 *   那是幾千個 AbortController 的洩漏,而症狀是「用了兩小時之後變慢」。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { abortRequest, releaseRequest, trackRequest, trackedCount } from '../aiAbort'

/** 本檔建立過的所有 requestId;afterEach 逐一釋放。 */
const created: string[] = []

function makeId(name: string): string {
  created.push(name)
  return name
}

describe('aiAbort 登錄表', () => {
  afterEach(() => {
    // map 是 module 級的,跨測試共享。清理要靠「記下自己登記過的 id」——
    // 寫成 while (trackedCount() > 0) releaseRequest(...) 會是**無限迴圈**,
    // 因為 release 刪的是那個不存在的 key,count 永遠不變(這條是踩過的)。
    for (const id of created.splice(0)) releaseRequest(id)
  })

  it('trackRequest 後 abortRequest 真的中止了那個 controller', () => {
    const id = makeId('req-1')
    const controller = trackRequest(id)

    expect(controller.signal.aborted).toBe(false)
    expect(abortRequest(id)).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  it('取消不存在的請求回 false(按得太慢不是錯誤)', () => {
    expect(abortRequest('never-existed')).toBe(false)
  })

  it('releaseRequest 後 map 不再持有它(否則會隨呼叫次數洩漏)', () => {
    trackRequest(makeId('req-1'))
    expect(trackedCount()).toBe(1)

    releaseRequest('req-1')
    expect(trackedCount()).toBe(0)

    // 已釋放的請求再取消:回 false,而且不影響別人
    expect(abortRequest('req-1')).toBe(false)
  })

  it('兩個請求各自獨立 —— 取消 A 不會動到 B', () => {
    const a = trackRequest(makeId('req-a'))
    const b = trackRequest(makeId('req-b'))

    abortRequest('req-a')

    expect(a.signal.aborted).toBe(true)
    // 關鍵:兩個頁面都能發起 AI 呼叫(會議摘要與面試回饋可能同時在跑)
    expect(b.signal.aborted).toBe(false)
  })

  it('同一個 requestId 重複進入時,舊的那個會被中止(不會永遠留在 map 裡)', () => {
    const id = makeId('dup')
    const first = trackRequest(id)
    const second = trackRequest(id)

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(trackedCount()).toBe(1)
  })

  it('逾時與取消對呼叫端是同一件事(同一個 aborted 旗標)', () => {
    // ollama.ts 與 ipc.ts 的 OpenAiChat 都靠 controller.signal.aborted
    // 決定回「已取消」還是回真實錯誤。這裡釘住那個判斷依據存在。
    const controller = trackRequest(makeId('req-timeout'))
    controller.abort() // 逾時路徑:setTimeout(() => controller.abort())

    expect(controller.signal.aborted).toBe(true)
  })
})
