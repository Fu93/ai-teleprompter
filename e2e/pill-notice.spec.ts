/**
 * pill-notice.spec.ts — 藥丸的兩條「島上才看得到」的回歸。
 *
 * 兩個症狀都來自同一個結構性原因:**島(藥丸)上只有一條訊息通道**,
 * 而展開面板底部那一區在藥丸模式根本沒有渲染。
 *
 *   1. 跟讀訊息(載入模型 X% / 聆聽中 / 跟讀啟動失敗)只長在展開面板底部 →
 *      用藥丸的人完全靜默:他按了跟讀,麥克風有沒有開、失敗沒失敗,畫面上
 *      一句話都沒有。這正是前一輪修隱私問題要解掉的狀況,卻只在藥丸下復發。
 *   2. Panic 出卡時藥丸只顯示「救援卡顯示中 — 點鈴鐺關閉」,而卡片本體
 *      (只有展開/貼鏡才渲染)根本看不到 —— 使用者在最需要救援的那一刻,
 *      看到的是一句叫他去看一個不存在的東西的提示。Alt+P 熱鍵路徑一模一樣。
 *
 * 執行需先 `npm run build`;AI_TP_E2E 由 playwright.config 注入。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function launch(): Promise<{ app: ElectronApplication; main: Page; overlay: Page }> {
  const app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    timeout: 60_000
  })
  let main: Page | undefined
  let overlay: Page | undefined
  for (let i = 0; i < 60; i++) {
    const all = app.windows()
    main = all.find((w) => !w.url().includes('overlay'))
    overlay = all.find((w) => w.url().includes('overlay'))
    if (main && overlay) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!main || !overlay) throw new Error('windows not ready')
  await main.waitForLoadState('domcontentloaded')
  await overlay.waitForLoadState('domcontentloaded')
  return { app, main, overlay }
}

test('藥丸不會吞掉跟讀訊息,Panic 也會自動把藥丸展開', async () => {
  test.setTimeout(120_000)
  const { app, main, overlay } = await launch()
  try {
    await main.evaluate(() =>
      window.api.overlayShow({
        title: '通知回歸',
        content: '各位好,今天要跟大家介紹三個重點。這是用來測試跟讀與救援提示的講稿內容。'
      })
    )
    await overlay.waitForTimeout(1_500)

    // ── A. 跟讀訊息必須在藥丸上補位 ──
    const followBtn = overlay.locator('[title="語音跟讀:唸到哪、捲到哪(需麥克風)"]')
    await expect(followBtn).toHaveCount(1)
    await followBtn.click()
    await overlay.waitForTimeout(400)
    // 收合成藥丸(藥丸才是被驗的對象;展開面板底部的狀態條不在藥丸上)
    const collapseBtn = overlay.locator('[title*="收合成藥丸"]')
    if ((await collapseBtn.count()) > 0) {
      await collapseBtn.click()
      await overlay.waitForTimeout(1_500)
    }
    const pill = overlay.locator('.dynamic-island-pill')
    await expect(pill).toHaveCount(1)
    // 三種狀態都算通過(哪一種取決於此環境能不能載入 Whisper 模型):
    // 重點是「藥丸上有訊息」而不是「訊息內容是什麼」——修正前這裡恆為空白。
    await expect(pill.locator('text=/跟讀啟動失敗|載入模型|聆聽中/').first()).toBeVisible({
      timeout: 20_000
    })

    // ── B. Panic 出卡:藥丸必須自己展開,救援卡才看得到 ──
    const panic = overlay.locator('[title^="Panic 救援"]')
    await expect(panic).toHaveCount(1)
    await panic.click()
    await overlay.waitForTimeout(2_000)
    // 已經不是藥丸寬度 = 自動展開真的發生
    const width = await overlay.evaluate(() => window.innerWidth)
    expect(width).toBeGreaterThan(320)
    await expect(overlay.locator('[data-overlay-card="rescue"]')).toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close().catch(() => undefined)
  }
})
