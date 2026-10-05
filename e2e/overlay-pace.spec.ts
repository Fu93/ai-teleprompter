/**
 * overlay-pace.spec.ts — 瞬時節奏讀數(P4)走真 IPC 的守衛。
 *
 * 為什麼是 e2e 而不是只靠單元測試:單元測試釘住估計器與判定的數學
 * (speakingPace.test.ts),但「main 有沒有在正確的時機送、浮層有沒有把它
 * 畫出來、停止說話後有沒有收起」是**接線** —— 這個 repo 已經吃過
 * 「邏輯全綠、那條路徑從來沒被執行過」的虧(見 docs/UX_FINDINGS.md 的
 * audit:effects 段落)。浮層端的稽核覆寫(overlay.coachingHint)刻意沒有
 * 給讀數用:推真的逐字稿才是真的驗到估計器。
 *
 * 時序:讀數沒有冷卻、也不吃 8 秒淡出,所以這條不像 meeting-flow 那樣
 * 對機器時序敏感 —— 它只依賴「段落送達間隔」本身(那由測試控制)。
 */
import { test, expect } from '@playwright/test'
import { launchApp as launchMain } from './helpers/launch'
import { waitOverlayFeedbackReady } from './helpers/turnYield'

test('瞬時節奏:連續快語速出現「偏快」讀數,停止後收起', async () => {
  const { app, main } = await launchMain()
  test.setTimeout(90_000)
  try {
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const overlay = app.windows().find((w) => w !== main)
    expect(overlay).toBeTruthy()
    await overlay!.waitForLoadState('domcontentloaded')

    // 持久化設定可能被使用者關過:這條測試要驗的是管線,先確定兩個開關是開的。
    await main.evaluate(() => window.api.setSettings({ overlay: { coaching: true } }))
    await waitOverlayFeedbackReady(overlay!, { turnYield: true, coaching: true })
    await main.evaluate(() => window.api.overlayShow({ title: '節奏', content: '測試內容' }))

    // 還沒有任何語音:不該有讀數。chip 不是一個「0 字/分」的謊 ——
    // 樣本不足時估計器回 null,main 不送,浮層不畫。
    const chip = overlay!.locator('[data-pace="1"]')
    expect(await chip.count()).toBe(0)

    // 連續快語速:每段 ~28 單位、間隔 1.2s。第 3 段起窗內有 3 段
    // (activeMs 3.9s、84 單位)→ 估計器有資格給數字,且遠超基準 → 偏快。
    const text = '這是一段很有節奏的連續說話內容大概三十個字左右的長度範例'
    for (let i = 1; i <= 5; i++) {
      await main.evaluate((t) => window.api.pushTranscript({ text: t, speaker: 'me' }), text)
      await main.waitForTimeout(1_200)
    }
    await expect(chip).toBeVisible({ timeout: 5_000 })
    await expect(chip).toHaveAttribute('data-pace-verdict', 'ahead')
    await expect(chip).toContainText('字/分')

    // 停止說話:10 秒窗把舊段落一個個淘掉,窗內剩 2 段時(發聲時間 2.7s
    // < 3s 下限)估計器回 null → main 送一次 null → chip 立刻收起。
    // 15 秒的上限涵蓋「最後一段出窗 + 下一拍 2 秒心跳」。
    await expect(chip).toHaveCount(0, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
