/**
 * settings-density-advice.spec.ts — 提詞密度建議(P3b)的接線守衛。
 *
 * 為什麼需要它:純函式 [suggestDisplayMode] 的門檻有 7 條單元測試,但
 * 「它有沒有真的被畫在設定頁上、而且該消失的時候真的消失」是**接線**,
 * 單元測試碰不到。這一類缺陷的症狀是「功能從來沒有出現過」——而畫面上
 * 沒有任何東西會說它去哪了,這也是這個 repo 反覆記錄過的失敗模式
 * (見 docs/UX_FINDINGS.md 的 audit:effects 段落)。
 *
 * 四個情境各自對應一個產品承諾:
 *   1. 未校準          → 不說話(沒有量測就不猜)
 *   2. 校準後偏快(340) → 建議「重點要點」
 *   3. 已經切到建議值   → 不再出現(不嘮叨)
 *   4. 樣本只有 5 秒   → 不說話(量測本身不穩,6 秒是下限)
 *
 * 執行需先 `npm run build`(與其他 spec 相同)。
 */
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/launch'

/** 側欄點擊(沒有開稽核橋,所以走真實路徑;與 settings-persistence 同一手法)。 */
async function gotoSettings(main: import('@playwright/test').Page): Promise<void> {
  await main.evaluate(() => {
    const b = [...document.querySelectorAll('aside button')].find((x) => x.textContent?.includes('設定')) as
      | HTMLElement
      | undefined
    b?.click()
  })
  await main.waitForTimeout(1200)
}

test('密度建議:未校準不說話、偏快建議重點要點、切過去就不再出現', async () => {
  test.setTimeout(90_000)
  const { app, main } = await launchApp()
  try {
    await gotoSettings(main)
    const advice = main.locator('[data-density-advice="1"]')

    // 1. 未校準:不猜。AI_TP_E2E 每次啟動都是全新 userData,所以 profile 是 null。
    // 等設定頁真的渲染出來(顯示模式是建議所在的那一區)
    await expect(main.getByText('顯示模式').first()).toBeVisible()
    await expect(advice).toHaveCount(0)

    // 2. 校準 340 字/分(≥300 的快側)→ 建議「重點要點」
    const seed = (charsPerMin: number, sampleSeconds: number): Promise<unknown> =>
      main.evaluate(
        (p) => window.api.setSettings({ personal: { profile: p } }),
        {
          calibratedAt: 1_760_000_000_000,
          ipdMm: 63,
          viewingDistanceCm: 60,
          hfovDeg: 60,
          charsPerMin,
          sampleSeconds,
          sampleChars: Math.round((charsPerMin * sampleSeconds) / 60),
          derivedFontSize: 30,
          derivedSpeed: 60
        }
      )
    await seed(340, 20)
    await expect(advice).toHaveCount(1)
    await expect(advice).toContainText('重點要點')

    // 3. 已經切到建議的模式:不再出現(建議不是嘮叨)
    await main.evaluate(() => window.api.setSettings({ overlay: { displayMode: 'bullet' } }))
    await expect(advice).toHaveCount(0)

    // 4. 慢讀者(150 ≤ 180)→ 建議「連續捲動」(與目前的 bullet 不同,所以會出現)
    await seed(150, 20)
    await expect(advice).toHaveCount(1)
    await expect(advice).toContainText('連續捲動')

    // 5. 樣本量測時間不足(5 秒 < 6 秒下限)→ 不說話
    await seed(150, 5)
    await expect(advice).toHaveCount(0)
  } finally {
    await app.close()
  }
})
