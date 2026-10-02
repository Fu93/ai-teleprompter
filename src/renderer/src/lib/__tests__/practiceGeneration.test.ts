/**
 * practiceGeneration.test.ts — 「舊的非同步回覆不得污染新的練習場次」這條不變量。
 *
 * 為什麼這需要一條不變量測試（而不是靠稽核截圖看出來）:
 *   Practice 在一輪練習裡同時有三個非同步來源會晚到:
 *     1. 語音辨識（逾時 65 秒後仍在飛,見 finishAnswerInner 的 drainPending）
 *     2. AI 評分 / 總評（可 abort,但 abort 不等於 promise 立刻 settle）
 *     3. IndexedDB 寫入（不可取消）
 *   這一輪新增的 GenerationGate 就是為了讓「reset 之後舊的回覆不得寫進新場次」。
 *   但閘門本身**擺在哪一行**才是關鍵:檢查晚寫一行,舊資料就從那個縫鑽進來。
 *
 *   finishAnswerInner 裡 `finalize()` + `setCurTranscript` + `pushTranscript`
 *   若排在 isCurrent 檢查之前,重置後逾時的回覆仍會:
 *     - 對**新**一輪的 segsRef 呼叫 finalize（等於提前釋放新場次還在飛的槽位）
 *     - 把舊逐字稿 push 進 main 的 panic/coaching 上下文（新場次會引用它）
 *
 * 這條測試**故意讀原始碼**。它量的是「原始碼裡閘門有沒有擺在正確的位置」,
 * 對應同樣會讀原始碼的稽核規則（見 practiceBusy.test.ts 的同一個模式）。
 *
 * ── 這條測試**證明不了**什麼(誠實揭露) ──
 *   它證明不了執行期的競態行為。而那個競態**在真實 UI 上不可重現**:
 *   「再練一輪」只在 done 階段渲染,run/draining 階段按不到;離開頁面則被
 *   App 的 leave guard 擋下。要在 e2e 裡逼出來就只能繞過產品 UI 直接改 React
 *   狀態 —— 那測的是測試夾具,不是產品。所以競態這一格刻意留白,而不是寫一條
 *   永遠綠的假 e2e。
 *
 *   e2e/practice-generation.spec.ts 覆蓋的是**另一件事**:逐字稿在真實 Electron
 *   + 真實 VAD + 真實 STT 呼叫下,依音訊槽位順序組裝(亂序回應時)。它不是這裡的證明。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(here, '../../pages/Practice.tsx'), 'utf8')

/** 取出某個函式本體的原始碼（以大括號配平,不用行號）。 */
function bodyOf(fnName: string): string {
  const start = SRC.indexOf(`const ${fnName} =`)
  expect(start, `原始碼裡找不到 ${fnName}`).toBeGreaterThanOrEqual(0)
  const open = SRC.indexOf('{', start)
  let depth = 0
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') {
      depth--
      if (depth === 0) return SRC.slice(open, i + 1)
    }
  }
  throw new Error(`${fnName} 的大括號沒有配平`)
}

describe('Practice 的世代閘門順序', () => {
  it('finishAnswerInner:isCurrent 閘門排在 finalize/pushTranscript 之前', () => {
    const body = bodyOf('finishAnswerInner')
    const guardAt = body.indexOf('if (!runGenerationRef.current.isCurrent(generation)) return')
    const finalizeAt = body.indexOf('.finalize()')
    const pushAt = body.indexOf('pushTranscript')

    // 閘門與副作用都必須存在,否則這條測試會因為「找不到」而靜默通過
    expect(guardAt, 'finishAnswerInner 缺少世代閘門').toBeGreaterThanOrEqual(0)
    expect(finalizeAt, 'finishAnswerInner 缺少 finalize').toBeGreaterThanOrEqual(0)
    expect(pushAt, 'finishAnswerInner 缺少 pushTranscript').toBeGreaterThanOrEqual(0)

    expect(guardAt, '世代閘門必須在 finalize 之前（否則舊回覆會釋放新場次的槽位）').toBeLessThan(finalizeAt)
    expect(guardAt, '世代閘門必須在 pushTranscript 之前（否則舊逐字稿污染新場次上下文）').toBeLessThan(pushAt)
  })

  it('finishAnswerInner:閘門之後才讀逐字稿（逾時提示用當下那一份）', () => {
    const body = bodyOf('finishAnswerInner')
    const guardAt = body.indexOf('if (!runGenerationRef.current.isCurrent(generation)) return')
    const readAt = body.indexOf('const transcript =')
    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(readAt).toBeGreaterThanOrEqual(0)
    expect(guardAt, '讀逐字稿前必須先確認世代仍然有效').toBeLessThan(readAt)
  })

  it('reset:閘門失效與 operation 計數都要歸零,否則舊流程會解鎖新的按鈕狀態', () => {
    const body = bodyOf('reset')
    expect(body).toMatch(/runGenerationRef\.current\.invalidate\(\)/)
    // finishingRef / finishingRunRef 必須被清掉,否則重置後按鈕永久 disabled
    expect(body).toMatch(/finishingRef\.current = false/)
    expect(body).toMatch(/finishingRunRef\.current = false/)
    // advancingRef 也要清:正在換題時重置,舊流程不得再推進
    expect(body).toMatch(/advancingRef\.current = false/)
  })

  it('startPractice:閘門在驗證 position 之前就要 advance（避免舊世代被誤認為當前）', () => {
    const body = bodyOf('startPractice')
    const nextAt = body.indexOf('runGenerationRef.current.next()')
    const validateAt = body.indexOf('position.trim()')
    expect(nextAt).toBeGreaterThanOrEqual(0)
    expect(validateAt).toBeGreaterThanOrEqual(0)
    // next() 必須在驗證之前,這一條是刻意的不變量:
    // 即使 position 沒填、流程被擋下,這一輪仍然算「開始過」,舊的遲到回覆作廢。
    expect(nextAt, '世代 must advance 在驗證之前').toBeLessThan(validateAt)
  })
})