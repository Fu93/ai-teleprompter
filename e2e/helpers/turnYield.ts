/**
 * turnYield.ts — e2e 端「浮層真的準備好接受即時回饋」的屏障。
 *
 * 為什麼需要這個檔案(這是本專案抓出的一個**真的測試設計錯誤**):
 *
 * `smoke.spec.ts` 的 turn-yield 測試原本這樣寫:
 *
 *   setSettings({ overlay: { turnYield: true } })
 *   await expect.poll(async () => {
 *     await pushTranscript('可以請你介紹一下你自己嗎', 'them')   // ← 同一句
 *     try { await overlay.waitForSelector('text=該你說話了', { timeout: 3_000 }); return true }
 *     catch { return false }
 *   }, { timeout: 30_000 }).toBe(true)
 *
 * 註解說「與其猜延遲不如重試到訊號真的出現為止」。**這個重試結構上不可能成功。**
 *
 * 追 `src/main/context-engine/turnYield.ts` 的規則 1:
 *
 *   if (state.lastFiredAt > 0 && text === state.lastFiredText
 *       && now - state.lastFiredAt < refireCooldownMs) return null   // refireCooldownMs = 25s
 *
 * 重試送的是**同一句話**。所以:
 *
 *   t=0     第一次 push → 無冷卻 → 判定 turn → 掛 1.2s 防抖
 *   t=1.2s  送出。若此刻浮層 renderer 還沒套用 turnYield=true
 *           (useTurnYield 在 enabled=false 時走 `if (!enabled) return`,
 *           **不註冊 listener**)→ 訊號丟掉
 *   t=3.5s  重試同一句 → 距上次記帳 < 25s → **回 null,一個訊號都發不出來**
 *   ...     換句話也一樣被 15s 全域冷卻擋住
 *
 * 結論:這支測試**只能靠第一次 push 成功**。第一次輸掉競態就必紅,
 * 而它唯一的補救機制被自己的冷卻規則廢掉。這就是「單跑綠、全量跑紅」的機制。
 *
 * 正確做法:那個競態(浮層還沒套用設定)**是可以直接觀察到的** ——
 * 工具列那顆按鈕的 title 在 turnYield 為真時會翻成「關閉「該你說話了」提示」
 * (見 OverlayApp.tsx)。等它翻好再推,就一次成功,不需要任何重試。
 */
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/** 開關打開時按鈕的 title 前綴(關閉時是「開啟「該你說話了」提示:…」) */
const TURN_YIELD_ON = '關閉「該你說話了」提示'
/** 即時教練打開時按鈕的 title 前綴 */
const COACHING_ON = '即時教練開啟中'

/**
 * 等浮層 renderer **真的套用**了 turnYield / coaching 設定。
 *
 * 為什麼等 DOM 而不是亂猜延遲:`setSettings` 回了只代表 main 端寫好了,
 * 廣播到浮層、React 重渲染、useTurnYield 重訂 listener 是三個後續步驟。
 * 滿載時這段會超過任何猜出來的延遲 —— 而按鈕 title 翻好就是這三步都完成的證據。
 *
 * 「功能關閉時按鈕長什麼樣」不在這裡處理:那是稽核腳本關心的另一件事。
 */
export async function waitOverlayFeedbackReady(
  overlay: Page,
  opts: { turnYield?: boolean; coaching?: boolean } = {}
): Promise<void> {
  if (opts.turnYield) {
    await expect
      .poll(
        async () =>
          overlay
            .locator(`button[title^="${TURN_YIELD_ON}"]`)
            .count()
            .catch(() => 0),
        // 30 次 × 500ms = 15 秒。健康環境 < 1 秒;逾時代表真的有問題。
        { timeout: 15_000, intervals: [500] }
      )
      .toBeGreaterThan(0)
  }
  if (opts.coaching) {
    await expect
      .poll(
        async () =>
          overlay
            .locator(`button[title^="${COACHING_ON}"]`)
            .count()
            .catch(() => 0),
        { timeout: 15_000, intervals: [500] }
      )
      .toBeGreaterThan(0)
  }
}
