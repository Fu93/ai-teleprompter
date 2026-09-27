/**
 * e2e 煙霧測試 — 以真實 Electron 進程啟動 app,走真 IPC 鏈
 * (v3 e2e/teleprompter-flow.spec.js 的精神,配新專案架構)
 *
 * 執行前需先 `npm run build`(測試載入 out/ 產物)。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function launchApp(): Promise<{ app: ElectronApplication; main: Page }> {
  const app = await electron.launch({ args: ['.'], timeout: 60_000 })
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  return { app, main }
}

test('啟動後有主視窗 + 浮層視窗,標題正確', async () => {
  const { app, main } = await launchApp()
  try {
    // renderer 側標題
    expect(await main.title()).toBe('AI 提詞機')
    // 浮層視窗與主視窗同時建立,但載入完成有先後 → 輪詢等待
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
  } finally {
    await app.close()
  }
})

test('preload 橋接可用:appInfo 回傳版本與平台', async () => {
  const { app, main } = await launchApp()
  try {
    const info = await main.evaluate(() => window.api.appInfo())
    expect(info.version).toBeTruthy()
    expect(info.platform).toBe('win32')
    expect(info.userDataPath).toContain('ai-teleprompter')
  } finally {
    await app.close()
  }
})

test('scene:list 經 IPC 回傳內建 8 場景 + pack 場景', async () => {
  const { app, main } = await launchApp()
  try {
    const scenes = await main.evaluate(() => window.api.sceneList())
    const keys = scenes.map((s) => s.key)
    expect(keys).toEqual(
      expect.arrayContaining(['interview', 'sales', 'investor', 'podcast', 'demo', 'support', 'defense', 'default'])
    )
    // 場景包含模板(fallback 用)
    expect(scenes.find((s) => s.key === 'interview')?.label).toBe('Job Interview')
  } finally {
    await app.close()
  }
})

test('設定讀寫經 IPC 生效且含 scenario 區塊', async () => {
  const { app, main } = await launchApp()
  try {
    const settings = await main.evaluate(() => window.api.getSettings())
    // 持久化設定可能被使用者改過 → 驗證結構與合法值域,不假設具體值
    expect(['scroll', 'phrase', 'bullet', 'karaoke']).toContain(settings.overlay.displayMode)
    expect(typeof settings.scenario.activeScene).toBe('string')
    expect(settings.scenario.activeScene.length).toBeGreaterThan(0)
    expect(typeof settings.scenario.aiModeEnabled).toBe('boolean')
    expect(settings.overlay.glass).toBeDefined()
    expect(typeof settings.hotkeys.panicRescue).toBe('string')
    expect(settings.hotkeys.panicRescue.length).toBeGreaterThan(0)
    // 寫入→讀回往返
    const roundTrip = await main.evaluate(async () => {
      const prev = (await window.api.getSettings()).overlay.rate
      await window.api.setSettings({ overlay: { rate: 1.5 } })
      const after = (await window.api.getSettings()).overlay.rate
      await window.api.setSettings({ overlay: { rate: prev } })
      return after
    })
    expect(roundTrip).toBe(1.5)
  } finally {
    await app.close()
  }
})
