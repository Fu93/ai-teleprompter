/**
 * playtest3.spec.ts — 第三輪真機 playtest:前兩輪未覆蓋的日常旅程
 * 1. 設定頁改熱鍵 → 衝突警告(熱鍵區從未有任何 e2e 觸碰)
 * 2. 設定頁選場景包場景 → 展開模式觸發 Panic → RescueCard 顯示場景包模板
 *    (上一輪只在藥丸形態測過 panic,展開模式 RescueCard + 場景包模板從未驗證)
 * 3. 雲端 STT 設定一路 UI 點選 → 錄音入庫(fake mic + mock STT server)
 *    (前兩輪都是用 main.evaluate 直接 setSettings,bypass 了設定頁 UI 的層層 select/輸入)
 * 執行需先 npm run build;AI_TP_E2E=1 由 playwright.config 注入(資料隔離)。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { Server } from 'node:http'
import http from 'node:http'

async function launchApp(): Promise<{ app: ElectronApplication; main: Page; overlay: Page }> {
  const app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    timeout: 60_000
  })
  await app.waitForEvent('window', { timeout: 30_000 })
  let main: Page | undefined
  let overlay: Page | undefined
  for (let i = 0; i < 60; i++) {
    const all = app.windows()
    main = all.find((w) => !w.url().includes('overlay'))
    overlay = all.find((w) => w.url().includes('overlay'))
    if (main && overlay) break
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!main || !overlay) throw new Error(`windows not ready: ${app.windows().length}`)
  await main.waitForLoadState('domcontentloaded')
  await overlay.waitForLoadState('domcontentloaded')
  return { app, main, overlay }
}

async function navTo(main: Page, label: string): Promise<void> {
  await main.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(l))
    btn?.click()
  }, label)
  await main.waitForTimeout(400)
}

test('熱鍵設定 → 衝突警告 → 設定持久化', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(60_000)
  try {
    await navTo(main, '設定')

    // 以選項值定位(設定頁 select 順序依 provider/engine 條件渲染,索引不可靠)
    const playPauseSelect = main.locator('select:has(option[value="Alt+K"])')
    await playPauseSelect.selectOption('Control+Alt+S')
    await main.waitForTimeout(400)
    const hotkeys = await main.evaluate(async () => (await window.api.getSettings()).hotkeys)
    expect(hotkeys.playPause).toBe('Control+Alt+S')

    // 2) 製造衝突:各熱鍵 select 的選項集合刻意互斥(預防優於警告),UI 下拉無法做出衝突;
    //    衝突警告的實際防線是 settings.json 手改等路徑 → 用同條 IPC 鏈(setSettings)製造
    await main.evaluate(() => window.api.setSettings({ hotkeys: { panicRescue: 'Control+Alt+S' } }))
    await expect(main.locator('text=熱鍵衝突')).toBeVisible({ timeout: 5_000 })

    // 3) 解除衝突:panicRescue 改回 Alt+P → 警告消失
    await main.evaluate(() => window.api.setSettings({ hotkeys: { panicRescue: 'Alt+P' } }))
    await expect(main.locator('text=熱鍵衝突')).toHaveCount(0, { timeout: 5_000 })

    // 4) 收尾還原預設(e2e 隔離 userData,但保持斷言可重複)
    await playPauseSelect.selectOption('Alt+K')
    await main.waitForTimeout(300)
    const restored = await main.evaluate(async () => (await window.api.getSettings()).hotkeys)
    expect(restored.playPause).toBe('Alt+K')
  } finally {
    await app.close()
  }
})

test('場景包場景選擇 → 展開模式 Panic 救援卡顯示場景包模板', async () => {
  const { app, main, overlay } = await launchApp()
  test.setTimeout(60_000)
  try {
    // 先準備一份講稿(展開模式才有內容;開始提詞讓浮層離開空狀態)
    await navTo(main, '提詞講稿')
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('新講稿'))
      btn?.click()
    })
    await main.waitForTimeout(300)
    await main.locator('textarea').fill('第一點,介紹產品願景。第二點,說明目標用戶。第三點,總結收尾。')
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('開始提詞'))
      btn?.click()
    })
    await expect(overlay.locator('[title^="暫停"]')).toHaveCount(1, { timeout: 5_000 })

    // 設定頁:關閉 AI 模式(panic 走模板路徑),選場景包場景 behavioral
    await navTo(main, '設定')
    await main.evaluate(() => window.api.setSettings({ scenario: { aiModeEnabled: false } }))
    // 場景包按鈕 title 含 label 與 source;behavioral 是 interview-essentials 的第一個場景
    await main.locator('button[title*="Behavioral Question"]').click()
    await main.waitForTimeout(300)
    const scene = await main.evaluate(async () => (await window.api.getSettings()).scenario.activeScene)
    // 場景包場景的 key 格式是 pack:<packId>:<sceneKey>(shared/types.ts)
    expect(scene).toBe('pack:flowprompt.interview-essentials:behavioral')

    // 展開模式浮層:直接點工具列 Panic 鈕(CI 機器的全域熱鍵可能被占用)
    await overlay.locator('[title^="Panic 救援"]').click()
    // AI 關閉 → 不經 thinking 直接模板卡;模板輪替 = turns.length % templates.length
    const card = overlay.locator('text=Panic 救援')
    await expect(card).toBeVisible({ timeout: 5_000 })
    await expect(overlay.locator('text=walk you through a specific situation').first()).toBeVisible({ timeout: 5_000 })
  } finally {
    await app.close()
  }
})

test('雲端 STT 設定頁 UI 全程點選 → 錄音入庫與報告', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(90_000)
  const mockStt: Server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ text: '我們的產品願景是幫助每個人在重要場合自信表達並且建立長期的溝通信心與表達能力' }))
  })
  await new Promise<void>((r) => mockStt.listen(0, '127.0.0.1', r))
  const port = (mockStt.address() as { port: number }).port
  try {
    // 設定頁「語音辨識」區塊:引擎是按鈕(不是 select);驗證 UI 層層接線
    // (前兩輪都是直接 setSettings,bypass 了這些欄位)
    await navTo(main, '設定')
    await main.locator('button', { hasText: '雲端 API' }).click()
    await main.locator('input[placeholder="https://api.groq.com/openai/v1"]').fill(`http://127.0.0.1:${port}/v1`)
    await main.locator('input[type="password"]').first().fill('test-key')
    await main.locator('input[placeholder="whisper-large-v3"]').first().fill('mock-whisper')
    await main.waitForTimeout(400)
    const stt = await main.evaluate(async () => (await window.api.getSettings()).stt)
    expect(stt.engine).toBe('cloud')
    expect(stt.cloud.model).toBe('mock-whisper')

    // 錄音頁:fake mic 開始聆聽 → mock 轉錄段落 → 停止並儲存 → 入庫+報告
    await navTo(main, '錄音轉錄')
    await main.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('input[type=checkbox]'))
      const mic = boxes.find((b) => b.closest('label')?.textContent?.includes('麥克風'))
      if (mic && !(mic as HTMLInputElement).checked) mic.click()
    })
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('開始聆聽'))
      btn?.click()
    })
    await expect(main.locator('text=聆聽中')).toBeVisible({ timeout: 10_000 })
    await main.waitForTimeout(6_000)
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('停止並儲存'))
      btn?.click()
    })
    await expect(main.locator('button', { hasText: '開始聆聽' })).toBeVisible({ timeout: 10_000 })
    await expect(main.locator('text=會後報告')).toBeVisible({ timeout: 5_000 })
  } finally {
    mockStt.close()
    await app.close()
  }
})
