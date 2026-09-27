/**
 * 模擬會議演練 — 以真實 app + 真 IPC 重播一場典型會議的語音節奏,
 * 驗證即時回饋管線(turn-yield + coaching)的觸發、時序與自動淡出,
 * 並逐訊號截圖存檔 docs/screenshots/。
 *
 * 執行:npx playwright test e2e/meeting-flow.spec.ts(需先 npm run build)
 *
 * ⚠️ 這是「編排式演示 spec」而非穩定回歸:六個階段共享 main 端冷卻狀態,
 * 推進節奏經多次調校(各階段間的等待都為避免燒掉後續冷卻),對機器時序敏感。
 * 建議單獨執行、偶發失敗重跑即可;回歸驗證請以 smoke.spec.ts 為準。
 *
 * 情境時間軸(與 app 內冷卻/防抖參數對齊):
 *  1. 對方問句            → turn-yield「該你說話了」(1.2s 防抖後)
 *  2. 我方連續快語速段落   → coaching fast「語速偏快」
 *  3. 我方填充詞 ×4/30s    → coaching filler「填充詞有點多」
 *  4. 對方講完 0.5s 我插話 → coaching interrupt「打斷對方」
 *  5. 全場靜音 ≥8s         → coaching dead_air「冷場中」
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function launchApp(): Promise<{ app: ElectronApplication; main: Page }> {
  const app = await electron.launch({ args: ['.'], timeout: 60_000 })
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  return { app, main }
}

/** 逐段推 transcript(帶真實間隔,讓 main 端時間戳自然展開) */
async function push(
  main: Page,
  speaker: 'me' | 'them',
  text: string,
  gapMs = 300
): Promise<void> {
  await main.evaluate(
    ({ speaker, text }) => window.api.pushTranscript({ text, speaker }),
    { speaker, text }
  )
  await main.waitForTimeout(gapMs)
}

test('模擬會議:六訊號逐段觸發並截圖', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(120_000)
  try {
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const overlay = app.windows().find((w) => w !== main)
    expect(overlay).toBeTruthy()
    await overlay!.waitForLoadState('domcontentloaded')

    // 兩個即時回饋功能強制開啟(持久化設定可能被使用者關過)
    await main.evaluate(() => window.api.setSettings({ overlay: { turnYield: true, coaching: true } }))

    // ---------- 1. 對方問句 → turn-yield ----------
    await push(main, 'them', '可以請你介紹一下你自己嗎')
    await overlay!.waitForSelector('text=該你說話了', { timeout: 8_000 })
    await overlay!.waitForTimeout(1600) // 等 1.2s main 防抖後的事件送達+渲染
    await overlay!.screenshot({ path: 'docs/screenshots/16-meeting-turn-yield.png' })
    // 先補一句對方話語重置靜音時鐘:淡出驗證若把靜音拉過 8s,
    // dead_air 的 2s timer tick 會在此燒掉 300s 冷卻,步驟 5 就永不觸發。
    // (renderer 的 6s 淡出計時與 main 推送互不干擾,驗證依然有效)
    await push(main, 'them', '好,那我們開始吧', 500)
    // 6s 自動淡出
    await overlay!.waitForTimeout(6200)
    expect(await overlay!.locator('text=該你說話了').count()).toBe(0)
    // 等 2.5s 再開始我方長段——否則第一個 me 段落在 2s 內到達,
    // 會把 interrupt 的 180s 冷卻在這裡燒掉,步驟 4 就永不觸發
    await overlay!.waitForTimeout(2_500)

    // ---------- 2. 我方連續快語速 → coaching fast ----------
    // 每段 ~30 單位、間隔 1.2s(連續);第 4 段起 cpm 超基準 1.3×。
    // 用 waitForSelector 連續輪詢,避免 count() 與 8s 顯示窗賽跑的 flake
    const fastText = '這是一段很有節奏的連續說話內容大概三十個字左右的長度範例'
    let fastFired = false
    for (let i = 1; i <= 12 && !fastFired; i++) {
      await push(main, 'me', fastText, 1200)
      try {
        await overlay!.waitForSelector('text=語速偏快', { timeout: 1500 })
        fastFired = true
      } catch {
        // 尚未觸發,繼續推
      }
    }
    expect(fastFired).toBe(true)
    await overlay!.screenshot({ path: 'docs/screenshots/17-meeting-fast.png' })
    // 只等 4s:靜音 8s 會觸發 dead_air 燒掉 300s 冷卻;banner 自然淡出即可
    await overlay!.waitForTimeout(4_000)
    await push(main, 'them', '好,那我們繼續', 500)
    // 再等 2.5s——否則下一階段的第一個 me 段落在 2s 內到達,
    // 會在這裡把 interrupt 的 180s 冷卻燒掉
    await overlay!.waitForTimeout(2_500)

    // ---------- 3. 填充詞 ×4/30s → coaching filler ----------
    for (let i = 1; i <= 4; i++) {
      await push(main, 'me', '嗯', 3000)
    }
    await overlay!.waitForSelector('text=填充詞有點多', { timeout: 5_000 })
    await overlay!.screenshot({ path: 'docs/screenshots/18-meeting-filler.png' })
    await overlay!.waitForTimeout(4_000) // 同上:避免燒掉 dead_air 冷卻

    // ---------- 4. 對方講完 0.5s 我插話 → coaching interrupt ----------
    await push(main, 'them', '那我們請你說明一下這個案例的背景')
    await main.waitForTimeout(500)
    await push(main, 'me', '這個專案主要是我負責資料管線的設計')
    await overlay!.waitForSelector('text=打斷對方', { timeout: 5_000 })
    await overlay!.screenshot({ path: 'docs/screenshots/19-meeting-interrupt.png' })

    // ---------- 5. 全場靜音 8s → coaching dead_air ----------
    // 提示顯示窗只有 8s,靜音 8s 就會觸發 → 只補睡 6s 就開始輪詢,
    // 睡過頭會錯過 banner(dead_air 冷卻 300s 不會重發)
    await overlay!.waitForTimeout(6_000)
    await overlay!.waitForSelector('text=冷場中', { timeout: 10_000 })
    await overlay!.screenshot({ path: 'docs/screenshots/20-meeting-dead-air.png' })

    // ---------- 6. 我方長段(非問句)→ turn-yield peer_silence 資訊提示 ----------
    // 步驟 4 的對方邀答句(「請你說明…」)本身會再觸發一次 turn;
    // 距它 ≥15s 後推長段,否則 peer_silence 被全域冷卻擋下且不會補發
    await overlay!.waitForTimeout(8_000)
    await push(
      main,
      'them',
      '我們團隊目前有八個人,主要負責後端與平台組,這個職位會負責資料管線的設計與維運,需要跨團隊溝通。'
    )
    await overlay!.waitForSelector('text=對方已停頓', { timeout: 8_000 })
  } finally {
    await app.close()
  }
})
