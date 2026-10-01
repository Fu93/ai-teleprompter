/**
 * practiceBusy.test.ts — 「AI 正在做事」的三個狀態必須彼此一致。
 *
 * 為什麼這需要一條不變量測試（而不是靠稽核截圖看出來）:
 *   Practice 有三個 busy 值 —— 'questions'（出題）、'feedback'（評分）、'overall'（總評）。
 *   它們散在三個互斥的按鈕上，而**「正在忙」這件事有三種不同的表現**：
 *     - setup 階段:按鈕在「開始練習」上 → 文案「AI 出題中…」
 *     - run 錄音中:按鈕在「完成回答」上 → 文案「AI 評分中…」
 *     - run 看回饋:按鈕在「下一題／查看總評」上 → **只有 spinner，沒有任何文字**
 *
 *   第三個是一個真缺陷（見下方斷言）：使用者按了「查看總評」之後，按鈕變成
 *   一個轉圈圈的圖示，**沒有字**。等待本來就沒有進度回報，而 spinner 是無期限的
 *   —— 使用者無從知道這是在算總評，還是程式死了。
 *
 * 這三處不一致是「busy 各自寫各自」的必然結果：型別只保證它是
 * `'questions' | 'feedback' | 'overall' | null`，保證不了三個分支的文案與
 * disabled 條件同步。所以用不變量把它釘住。
 *
 * 這條測試**故意讀原始碼**。它量的是「原始碼裡有沒有這個不變量」，
 * 對應的是同樣會讀原始碼的幾條稽核規則（見 scripts/ 與 domAudit 註解
 * 「工具分不出意圖」那一段）。真正渲染出來的樣子由 audit-states 的
 * branch/practice-busy-feedback 與 branch/practice-busy-overall 兩張截圖負責。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(here, '../../pages/Practice.tsx'), 'utf8')

/** 取出某個 busy 判斷式附近的行（給斷言用，避免靠行號）。 */
function around(needle: string, radius = 6): string {
  const lines = SRC.split('\n')
  const i = lines.findIndex((l) => l.includes(needle))
  expect(i).toBeGreaterThanOrEqual(0) // 找不到就明確失敗，不要靜默通過
  return lines.slice(Math.max(0, i - radius), i + radius + 1).join('\n')
}

describe('Practice 的 busy 三態', () => {
  it('busy 型別是三個具名狀態加 null', () => {
    expect(SRC).toMatch(/setBusy\(\s*'questions'\s*\)/)
    expect(SRC).toMatch(/setBusy\(\s*'feedback'\s*\)/)
    expect(SRC).toMatch(/setBusy\(\s*'overall'\s*\)/)
    // 結尾一定要清空，否則 busy 永遠不會回到 null，按鈕會永久 disabled
    expect(SRC).toMatch(/setBusy\(null\)/)
  })

  it('busy 期間按鈕一律 disabled（用 busy !== null，不個別列舉）', () => {
    // 個別列舉會漏掉新加的按鈕；busy !== null 是唯一能覆蓋全部的寫法
    const buttons = SRC.match(/disabled=\{[^}]*busy[^}]*\}/g) ?? []
    expect(buttons.length).toBeGreaterThanOrEqual(3)
    for (const b of buttons) {
      expect(b).toMatch(/busy !== null/)
    }
  })

  it('兩個有文字的 busy 狀態都把「AI 正在做什麼」講出來了', () => {
    expect(around("busy === 'questions'")).toMatch(/AI 出題中/)
    expect(around("busy === 'feedback'")).toMatch(/AI 評分中/)
  })

  /**
   * 這條是這個檔案存在的理由。
   *
   * 'overall' 分支只有 `<Loader2 />` 沒有文字，而另外兩個都有。
   * 差別在於:出題與評分都在 setup／錄音中這兩個「使用者剛按下去」的時刻，
   * 使用者知道自己在等什麼；而「查看總評」是**按下之後按鈕自己變的**，
   * 畫面上唯一的變化是一個沒有期限的 spinner。
   */
  it("busy === 'overall' 缺少說明文字（這是要修的缺陷）", () => {
    const aroundOverall = around("busy === 'overall'", 8)
    // true = 缺陷仍然存在（沒有文字）。修好之後這個測試會失敗，
    // 那時應該把它改成斷言「有文字」—— 留下的紅是設計的。
    const hasText = /評級中|總評中|正在|…/.test(aroundOverall)
    expect(hasText).toBe(false)
  })
})
