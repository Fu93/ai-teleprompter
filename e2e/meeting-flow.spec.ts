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
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchApp as launchMain } from './helpers/launch'
import { waitOverlayFeedbackReady } from './helpers/turnYield'

/** 共用 helper 會篩出真正的主視窗(有側欄的那個),見 helpers/launch.ts */
async function launchApp(): Promise<{ app: Awaited<ReturnType<typeof launchMain>>['app']; main: Page }> {
  const { app, main } = await launchMain()
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
    // 等浮層真的套用兩個開關再開始編排。否則第一發可能送在 renderer 還沒
    // 訂閱 listener 的空窗期,而 turn-yield 的 1.2s 防抖又不會補送 ——
    // 訊號就憑空消失。完整病因見 helpers/turnYield.ts。
    await waitOverlayFeedbackReady(overlay!, { turnYield: true, coaching: true })
    // **把浮層叫出來。**
    //
    // 浮層以 `show: false` 建立(createOverlayWindow,沒有 ready-to-show→show),
    // 預設就是隱藏的;而 Playwright 讀得到 win.hide() 之後的 DOM。所以這支測試
    // 原本是在一個使用者**永遠看不到的視窗**裡驗「提示有沒有出現」。
    //
    // sendTurnYield 現在會檢查 isVisible():對隱藏浮層回報「沒送到」,因為
    // webContents.send() 不會回報有沒有 listener,而隱藏時就算 listener 在、
    // 訊號也進了 DOM,6 秒的 HINT_DISPLAY_MS 一樣會在沒人看的狀態裡走完 ——
    // 然後那句話就被自己的 25 秒冷卻擋掉了。加上這行之後這支測試才真的在
    // 量使用者遇到的情境;截圖也才真的拍得到東西。
    await main.evaluate(() => window.api.overlayShow({ title: '會議', content: '測試內容' }))

    // dead_air 從這裡就開始「被觀察」,而不是等到步驟 5。
    //
    // 為什麼必須這樣:dead_air 的冷卻是 300 秒,而觸發條件是「全場靜音 8 秒」。
    // 這支測試的前置步驟隨便就累積超過 8 秒靜音,所以事件幾乎必然在前段就
    // 先觸發並燒掉冷卻 —— 到了步驟 5 不管等多久都不會再來第二次
    // (實測 HEAD 有 2/3 的失敗率,就是這個原因)。
    // 之前試過「在步驟 5 推一句話重置靜音時鐘」,同樣沒用:重置的是時鐘,
    // 燒掉的冷卻不會回來。
    // 正確做法是把它當成「全程都可能在發生的事件」來觀察,而不是排程它。
    let deadAirSeen = false
    const deadAirPromise = (async (): Promise<boolean> => {
      for (let i = 0; i < 500; i++) {
        const hit = await overlay!
          .evaluate(() => document.body.innerText.includes('冷場中'))
          .catch(() => false)
        if (hit) {
          deadAirSeen = true
          await overlay!.screenshot({ path: 'docs/screenshots/20-meeting-dead-air.png' })
          return true
        }
        await overlay!.waitForTimeout(200)
      }
      return false
    })()

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

    // ---------- 5. dead_air 已由上方背景觀察器捕捉 ----------
    expect(deadAirSeen || (await deadAirPromise)).toBe(true)

    // ---------- 6. 我方長段(非問句)→ turn-yield peer_silence 資訊提示 ----------
    // 步驟 4 的對方邀答句(「請你說明…」)本身會再觸發一次 turn;
    // 距它 ≥15s 後推長段,否則 peer_silence 被全域冷卻擋下且不會補發。
    // 步驟 5 改成背景觀察後不再固定消耗 6~16 秒,所以這裡不能只靠
    // 「前面等了一下」碰巧累積到 15 秒,必須自己把時間補回來。
    await overlay!.waitForTimeout(16_000)
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
