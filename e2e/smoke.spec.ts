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
    // e2e 進程以 AI_TP_E2E=1 啟動,除錯能力必須是關的:否則除錯面板會出現在
    // 每一張稽核截圖與 DOM 稽核裡,量到的就不是使用者所見(見 src/main/debug.ts)
    expect(info.debug).toBe(false)
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

test('turn-yield:對方問句經 IPC → 浮層顯示「該你說話了」提示', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(60_000)
  try {
    // 浮層視窗載入有先後 → 輸詢等待
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const overlay = app.windows().find((w) => w !== main)
    expect(overlay).toBeTruthy()
    await overlay!.waitForLoadState('domcontentloaded')

    // 強制開啟(使用者可能關過;開關持久化在 settings.json)
    await main.evaluate(() => window.api.setSettings({ overlay: { turnYield: true } }))
    // 經真 IPC 推對方問句(與 Record 頁系統音訊轉錄相同的 context:push-transcript 路徑)
    // main 偵測問句語尾 → 1.2s 防抖 → 廣播 context:turn-yield → 浮層提示
    //
    // 與下方教練測試同樣的竞態:setSettings 回了不代表浮層 renderer 已套用
    // turnYield=true,滿載時推送可能先到而被忽略。與其猜延遲不如重試到訊號真的出現。
    await expect
      .poll(
        async () => {
          await main.evaluate(() =>
            window.api.pushTranscript({ text: '可以請你介紹一下你自己嗎', speaker: 'them' })
          )
          try {
            await overlay!.waitForSelector('text=該你說話了', { timeout: 3_000 })
            return true
          } catch {
            return false
          }
        },
        { timeout: 30_000, intervals: [3_500] }
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})

test('即時教練:搶話訊號經 IPC → 浮層顯示教練提示', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(60_000)
  try {
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const overlay = app.windows().find((w) => w !== main)
    expect(overlay).toBeTruthy()
    await overlay!.waitForLoadState('domcontentloaded')

    await main.evaluate(() => window.api.setSettings({ overlay: { coaching: true } }))
    // 對方剛講完 → 2s 內我方開口 = 搶話。
    // 兩段必須在同一個 evaluate 內背靠背送出:分開兩次呼叫在併跑負載下
    // 可能間隔超過 2s 判定窗,搶話不觸發(併跑 flake 來源)。
    //
    // 另一個 flake 來源是「設定廣播」與「逐字稿推送」的競態:setSettings 回了不代表
    // 浮層 renderer 已經套用 coaching=true,滿載時推送可能先到而被忽略。
    // 與其猜延遲,不如重試到訊號真的出現為止 —— 斷言本身不變,走的仍是
    // 真 IPC → main 教練判定 → 浮層渲染 的完整路徑。
    await expect
      .poll(
        async () => {
          await main.evaluate(() => {
            void window.api.pushTranscript({ text: '那我們請你說明一下這個案例的背景', speaker: 'them' })
            void window.api.pushTranscript({ text: '這個專案主要是我負責資料管線的設計', speaker: 'me' })
          })
          try {
            await overlay!.waitForSelector('text=打斷對方', { timeout: 3_000 })
            return true
          } catch {
            return false
          }
        },
        { timeout: 30_000, intervals: [3_500] }
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})
/**
 * P2:執行中拔螢幕 / 改解析度會讓浮層座標失效而「靜默消失」——
 * 使用者在台上沒有任何錯誤提示,只能靠盲按熱鍵猜。
 * 這支測試兩個出口:重新顯示時的自動拉回,與工具列的「置中」按鈕。
 */
test('浮層掉出畫面:自動拉回 + 工具列「置中」按鈕', async () => {
  const { app, main } = await launchApp()
  test.setTimeout(60_000)
  try {
    await expect
      .poll(() => app.windows().length, { timeout: 15_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThanOrEqual(2)
    const overlayPage = app.windows().find((w) => w !== main)!
    await overlayPage.waitForLoadState('domcontentloaded')
    await main.evaluate(() => window.api.overlayShow({ title: '置中測試', content: '測試內容' }))

    // 浮層與主視窗共用同一份 index.html,標題都是「AI 提詞機」,
    // 只能用 URL hash(#/overlay)區分 —— 這也是先前測試抓錯視窗的原因。
    const overlayId = await app.evaluate(({ BrowserWindow }) => {
      // dev 是 #/overlay、packaged 是 #overlay(win.loadFile 的 hash 會吃掉斜線),兩種都收
      const isOverlay = (u: string): boolean => u.endsWith('#overlay') || u.endsWith('#/overlay')
      const w = BrowserWindow.getAllWindows().find((x) => isOverlay(x.webContents.getURL()))
      return w ? w.id : -1
    })
    expect(overlayId).toBeGreaterThan(0)

    const posOf = (): Promise<number> =>
      app.evaluate(({ BrowserWindow }, id) => {
        const w = BrowserWindow.fromId(id)
        return w && !w.isDestroyed() ? w.getPosition()[0] : Number.POSITIVE_INFINITY
      }, overlayId)
    const shoveOffscreen = (): Promise<void> =>
      app.evaluate(({ BrowserWindow }, id) => {
        BrowserWindow.fromId(id).setPosition(-4000, -4000)
      }, overlayId)

    // 模擬「執行中拔掉螢幕」:推到遠離任何螢幕的座標
    await shoveOffscreen()
    // 先確認前提成立,避免測試在「其實沒推出去」的假前提下通過
    expect(await posOf()).toBeLessThan(-3000)

    // 出口 1:自動防護 —— 重新顯示時 setOverlayVisible 會先 ensureOverlayOnScreen
    await main.evaluate(() => window.api.overlayShow({ title: '置中測試', content: '測試內容' }))
    await expect.poll(posOf).toBeGreaterThan(-3000)

    // 出口 2:使用者手動 —— 工具列「置中」按鈕
    await shoveOffscreen()
    expect(await posOf()).toBeLessThan(-3000)

    const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    // 用 DOM click 而非真實指標點擊:浮層是 transparent + alwaysOnTop 的無邊框視窗,
    // 真實點擊還要過 Playwright 的 actionability(命中測試)檢查,在滿載時會不穩。
    // 而這裡要驗證的是「按鈕 → preload → IPC → 視窗移動」這條鏈,不是浮層的點擊穿透
    // ——穿透由 setOverlayVisible 處理,另有測試涵蓋。
    await overlayPage.locator('button[title^="浮層置中"]').dispatchEvent('click')
    // 落在工作區內,而不只是「x 座標變正」
    await expect.poll(posOf).toBeGreaterThan(workArea.x - 10)
    await expect.poll(posOf).toBeLessThan(workArea.x + workArea.width)
  } finally {
    await app.close()
  }
})
