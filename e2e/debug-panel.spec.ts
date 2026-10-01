/**
 * e2e — UI/UX 除錯層(AI_TP_DEBUG)
 *
 * 這支測試要鎖住兩件事:
 *   1. 有 AI_TP_DEBUG=1 時,面板/HUD/浮層快照真的可用(而不是只有型別存在)。
 *   2. 沒有這個旗標時,除錯 UI 完全不存在 —— 這條更重要。
 *      playwright.config.ts 會設 AI_TP_E2E=1,e2e 與稽核腳本都是在「未打包」的
 *      Electron 裡跑;若 gate 只看 !app.isPackaged,除錯面板就會出現在每一張稽核
 *      截圖與 DOM 稽核裡(它的外框與小按鈕會被當成缺陷報出來)。
 *
 * 執行前需先 `npm run build`。
 */
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchApp as launchMain } from './helpers/launch'

/**
 * 依旗標啟動:env 一律顯式給,避免測試之間互相汙染。
 *
 * 用共用 helper 篩主視窗(見 helpers/launch.ts)。這支測試第一次失敗時報的是
 * 「element not found」—— 熱鍵面板沒開。當時我猜是全域熱鍵被佔用,
 * 但查過之後不成立:面板是用 DOM 點開的,不走 globalShortcut。
 * 真正的嫌疑是拿錯了視窗,而 helper 從此杜絕這條路徑。
 */
async function launch(debug: boolean): Promise<{ app: Awaited<ReturnType<typeof launchMain>>['app']; main: Page }> {
  const env = { ...process.env }
  if (debug) env.AI_TP_DEBUG = '1'
  else delete env.AI_TP_DEBUG
  const { app, main } = await launchMain(env)
  return { app, main }
}

const HOTKEY = 'Control+Shift+D'

test('AI_TP_DEBUG=1:面板預設關閉,快捷鍵可開關,四個頁籤都在', async () => {
  const { app, main } = await launch(true)
  try {
    const info = await main.evaluate(() => window.api.appInfo())
    expect(info.debug).toBe(true)

    // 能力存在 ≠ 畫面被汙染:預設必須是關閉的
    await expect(main.locator('#debug-panel')).toHaveCount(0)

    await main.keyboard.press(HOTKEY)
    await expect(main.locator('#debug-panel')).toBeVisible()

    const panel = main.locator('#debug-panel')
    // 以 role=button 定位頁籤:「狀態」也出現在狀態頁的列標籤上(span),
    // 用 getByText 會命中兩個節點而 strict mode 直接失敗。
    for (const label of ['狀態', '版面', '事件', '動作']) {
      await expect(panel.getByRole('button', { name: label, exact: true })).toBeVisible()
    }

    // 事件頁應已記錄除錯層啟動(事件流是這個面板最有價值的一塊)
    await panel.getByRole('button', { name: '事件', exact: true }).click()
    await expect(panel.getByText('debug', { exact: true })).toBeVisible()
    await expect(panel.getByText('除錯層啟動', { exact: false })).toBeVisible()

    // 版面開關要真的改變文件的 class(純 UI 開關不代表會生效)
    await panel.getByRole('button', { name: '版面', exact: true }).click()
    await panel.getByRole('button', { name: '元素外框', exact: true }).click()
    await expect
      .poll(() => main.evaluate(() => document.documentElement.classList.contains('dbg-outline')))
      .toBe(true)
    // 再按一次必須關掉:開關要真的雙向,不能只加不移
    await panel.getByRole('button', { name: '元素外框', exact: true }).click()
    await expect
      .poll(() => main.evaluate(() => document.documentElement.classList.contains('dbg-outline')))
      .toBe(false)

    await main.keyboard.press(HOTKEY)
    await expect(main.locator('#debug-panel')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('沒有旗標時除錯 UI 完全不存在(正式路徑與稽核量測不受影響)', async () => {
  const { app, main } = await launch(false)
  try {
    const info = await main.evaluate(() => window.api.appInfo())
    expect(info.debug).toBe(false)

    // 連按快捷鍵也不該冒出任何東西
    await main.keyboard.press(HOTKEY)
    await main.waitForTimeout(300)
    await expect(main.locator('#debug-panel')).toHaveCount(0)
    await expect(main.locator('#debug-hud')).toHaveCount(0)

    // 停用時 IPC 一律拒絕,能力不是「存在但藏起來」
    expect(await main.evaluate(() => window.api.debugOverlaySnapshot())).toBeNull()
    expect(await main.evaluate(() => window.api.debugOverlayInfo())).toBeNull()
    expect(await main.evaluate(() => window.api.debugOpenDevTools('main'))).toBe(false)
    expect(await main.evaluate(() => window.api.debugEmitSignal({ kind: 'turn' }))).toBe(false)
  } finally {
    await app.close()
  }
})

test('浮層狀態快照:經 main 的 executeJavaScript 取回引擎與視窗欄位', async () => {
  const { app, main } = await launch(true)
  try {
    await main.evaluate(() =>
      window.api.overlayShow({ title: '除錯快照', content: '第一句。第二句。第三句。' })
    )
    // 浮層的 __debugSnapshot 要等它自己的 appInfo 解析完才安裝 → 輪詢
    await expect
      .poll(
        async () => {
          const s = await main.evaluate(() => window.api.debugOverlaySnapshot())
          return s ? Object.keys(s).sort() : null
        },
        { timeout: 20_000, intervals: [500, 1_000, 2_000] }
      )
      .toEqual(
        expect.arrayContaining(['mode', 'status', 'sentenceIndex', 'follow', 'win', 'model'])
      )

    const snapshot = (await main.evaluate(() => window.api.debugOverlaySnapshot())) as {
      mode: string
      status: string
      win: { w: number; h: number }
      model: { sentences: number }
    }
    expect(snapshot.mode).toBe('scroll')
    // overlayShow 會自動播放("開始提詞"= 打開就開始講),所以狀態是跑起來的;
    // 這裡只鎖「是引擎的合法狀態」,不鎖時間點以免時序脆弱。
    expect(['playing', 'paused', 'completed', 'idle']).toContain(snapshot.status)
    // 視窗尺寸是即時讀的:浮層預設 720x260(見 DEFAULT_SETTINGS.overlay)
    expect(snapshot.win.w).toBeGreaterThan(240)
    expect(snapshot.model.sentences).toBeGreaterThan(0)

    // 浮層視窗層級資訊由 main 直接量,不依賴 renderer
    const info = await main.evaluate(() => window.api.debugOverlayInfo())
    expect(info).not.toBeNull()
    expect(info!.width).toBeGreaterThan(240)
    expect(info!.scaleFactor).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
