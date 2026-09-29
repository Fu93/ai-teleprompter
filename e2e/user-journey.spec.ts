/**
 * user-journey.spec.ts — 第一次使用者完整旅程回歸測試
 * 啟動 → 空狀態引導 → 建講稿 → 開始提詞(自動播放) → 靈動島藥丸互動
 * (光暈/事件彈入縮回/穿透自動解除/no-drag 佈局) → 錄音轉錄 → 會後報告 coaching chips。
 * 執行需先 `npm run build`;測試資料隔離(AI_TP_E2E,見 playwright.config)。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function launchApp(): Promise<{ app: ElectronApplication; main: Page; overlay: Page }> {
  const app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    timeout: 60_000
  })
  await app.waitForEvent('window', { timeout: 30_000 })
  // firstWindow 不保證是主視窗,且載入早期 URL 是 about:blank → 輪詢到兩窗各就各位
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

test('第一次使用者的完整流程', async () => {
  const { app, main, overlay } = await launchApp()
  test.setTimeout(120_000)
  try {
    // 1) 啟動:兩窗皆就緒(launchApp 已按 hash 認窗)
    await overlay.waitForTimeout(600)

    // 2) 空狀態:浮層應引導使用者去建講稿
    await expect(overlay.locator('text=尚未載入講稿')).toBeVisible({ timeout: 5_000 })

    // 3) 建講稿(照 UI 一路點)
    await navTo(main, '提詞講稿')
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('新講稿'))
      btn?.click()
    })
    await main.waitForTimeout(300)
    await main
      .locator('textarea')
      .fill(
        Array.from({ length: 10 }, (_, i) => `第${i + 1}點,我們的產品願景是幫助每個人在重要場合自信地表達自己並且建立長期信心。`).join('\n')
      )
    // 4) 開始提詞 → 浮層載入 + 自動播放
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('開始提詞'))
      btn?.click()
    })
    // 自動播放:暫停鈕出現 = 正在播(展開模式 title 為「暫停(空白鍵)」)
    // (診斷教訓:短講稿 0.9s 就播完轉 completed,斷言要緊跟載入,不能先等固定秒數)
    await expect(overlay.locator('[title^="暫停"]')).toHaveCount(1, { timeout: 5_000 })

    // 5) 收合成藥丸:靈動島驗證
    await overlay.locator('[title*="收合成藥丸"]').click()
    await overlay.waitForTimeout(1_200)
    const pill = overlay.locator('.dynamic-island-pill')
    await expect(pill).toHaveCount(1)
    // Liquid Glass 改版後:輪廓由 CSS 的方向性 rim light 表達,
    // 彩色呼吸光暈(--di-glow)與游標 specular 都已移除。
    // 這裡反向錨定,確保舊的光暈層不會回來(它就是白邊的最終元凶)。
    // lg-rim 是與 pill 同一個元素上的 class(不是子元素)
    await expect(pill).toHaveClass(/lg-rim/)
    const glassState = await pill.evaluate((el) => ({
      hasDiGlowVar: el.style.getPropertyValue('--di-glow').length > 0,
      borderTop: getComputedStyle(el).borderTopWidth,
      hasSpecular: !!el.querySelector('.glass-specular')
    }))
    expect(glassState.hasDiGlowVar).toBe(false)
    // 邊框已改為無邊框(輪廓不再靠線條定義),確認 0px
    expect(glassState.borderTop).toBe('0px')
    expect(glassState.hasSpecular).toBe(false)
    // no-drag 按鈕數:panic/播放/展開 = 3(穿透鈕在展開模式)
    const noDrag = await pill.evaluate((el) => el.querySelectorAll('[style*="no-drag"]').length)
    expect(noDrag).toBeGreaterThanOrEqual(3)

    // 6) 事件升為主角:推對方問句 → 藥丸顯示「該你說話了」
    await main.evaluate(() => window.api.pushTranscript({ text: '可以請你說明一下這個專案的背景嗎', speaker: 'them' }))
    const ev = pill.locator('.di-event')
    await expect(ev).toBeVisible({ timeout: 6_000 })
    await expect(ev).toContainText('該你說話了')
    // 事件期間狀態改用圖示表達(不再有光暈變數),確認搶話圖示已上色
    const iconDuring = await ev.locator('svg').first()
    await expect(iconDuring).toBeVisible()
    const iconColor = await iconDuring.evaluate((el) => getComputedStyle(el).color)
    expect(iconColor).not.toBe('rgb(255, 255, 255)')
    // 事件淡出後縮回常規內容(6s 顯示 + 0.28s 退場 + 餘裕;常規內容的標題是講稿標題)
    await expect(ev).toHaveCount(0, { timeout: 10_000 })
    await expect(pill.locator('span.font-mono')).toBeVisible({ timeout: 3_000 })

    // 7) 穿透單向門:展開 → 開穿透 → 隱藏 → 再顯示 → 穿透自動解除
    await pill.locator('[title="展開完整面板"]').click()
    await overlay.waitForTimeout(1_200)
    await overlay.locator('[title^="滑鼠穿透"]').click()
    await overlay.waitForTimeout(400)
    let st = await main.evaluate(() => window.api.getSettings())
    expect(st.overlay.clickThrough).toBe(true)
    await main.evaluate(() => window.api.overlayHide())
    await overlay.waitForTimeout(400)
    await main.evaluate(() => window.api.overlayToggle())
    await overlay.waitForTimeout(600)
    st = await main.evaluate(() => window.api.getSettings())
    expect(st.overlay.clickThrough).toBe(false)

    // 8) coaching 計數累積(main 端;Record 報告的資料來源)
    await main.evaluate(() => {
      void window.api.pushTranscript({ text: '那我們請你說明一下這個案例的背景', speaker: 'them' })
      void window.api.pushTranscript({ text: '這個專案主要是我負責資料管線的設計', speaker: 'me' })
    })
    await main.waitForTimeout(500)
    const counts = await main.evaluate(() => window.api.coachingStats())
    expect(counts['interrupt']).toBeGreaterThanOrEqual(1)
    await main.evaluate(() => window.api.contextReset())
    const after = await main.evaluate(() => window.api.coachingStats())
    expect(Object.keys(after).length).toBe(0)

    // 9) Record 頁輕量流程:fake mic 開始聆聽 → 停止並儲存(session 入庫 + 會後報告)
    //    內建迷你 mock 轉錄 server(spec 進程內),讓 fake mic 音訊真的轉出段落
    const http = await import('node:http')
    const mockSrv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ text: '那我們請你說明一下這個案例的背景' }))
      })
    })
    await new Promise<void>((r) => mockSrv.listen(0, '127.0.0.1', r))
    const port = (mockSrv.address() as { port: number }).port
    await navTo(main, '錄音轉錄')
    await main.evaluate((p) => {
      void window.api.setSettings({
        stt: { engine: 'cloud', cloud: { baseUrl: `http://127.0.0.1:${p}/v1`, apiKey: 'x', model: 'm' } }
      })
      void window.api.setSettings({ overlay: { coaching: true } })
    }, port)
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
    // fake mic 白噪連續(VAD 不切斷)→ 只有 flush 出的一段「我」;chips 驗證另以真實 IPC
    // 推入 them→me 對話(與錄音共用的同一條 main 端 coaching 管線)來累積搶話計數
    await main.waitForTimeout(1_000)
    await main.evaluate(() => {
      void window.api.pushTranscript({ text: '那我們請你說明一下這個案例的背景', speaker: 'them' })
      void window.api.pushTranscript({ text: '這個專案主要是我負責資料管線的設計', speaker: 'me' })
    })
    await main.waitForTimeout(5_000)
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('停止並儲存'))
      btn?.click()
    })
    // 停止後:控制列回到「開始聆聽」狀態 = 流程走完(頁面另有同文字提示,限縮到按鈕)
    await expect(main.locator('button', { hasText: '開始聆聽' })).toBeVisible({ timeout: 10_000 })
    // 會後報告出現且有 coaching chips(搶話:them 段後 me 段接上)
    await expect(main.locator('text=會後報告')).toBeVisible({ timeout: 5_000 })
    // 時長必須是實錄的幾秒鐘,不是天文數字——曾因 stop() 先歸零 startedAtRef
    // 才讀取,每場會議的 startedAt 存成 0、時長爆表(回歸鎖)
    const reportText = await main.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.card')).find((c) => c.textContent?.includes('會後報告'))
      return el?.textContent ?? ''
    })
    const durMatch = reportText.match(/時長\s*(\d+):(\d{2})/)
    expect(durMatch).toBeTruthy()
    const durSec = Number(durMatch![1]) * 60 + Number(durMatch![2])
    expect(durSec).toBeGreaterThan(0)
    expect(durSec).toBeLessThanOrEqual(120)
    const chips = await main.evaluate(() => document.body.textContent ?? '')
    if (!chips.includes('搶話')) throw new Error('會後報告沒有搶話 chip: ' + chips.slice(chips.indexOf('會後報告'), chips.indexOf('會後報告') + 400))
    mockSrv.close()
  } finally {
    await app.close()
  }
})
