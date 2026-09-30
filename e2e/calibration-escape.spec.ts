/**
 * calibration-escape.spec.ts — 校準頁的「佔用裝置」生命週期與 Esc 行為。
 *
 * 兩個回歸:
 *   1. 離開步驟 0 必須關掉相機。原本兩顆「下一步」(相機距離確認、手動距離繼續)
 *      都只呼叫 setStep,於是相機、rAF 迴圈與攝影機指示燈一路亮到步驟 2 結束或
 *      離頁 —— 步驟 1/2 畫面上什麼都看不到,使用者只知道「鏡頭燈一直亮著」。
 *   2. Esc 的行為要跟著「這個步驟看得到什麼」:步驟 0 有相機就關相機,
 *      步驟 1 有錄音就停止朗讀。原本寫成 `if (cameraOn) stopCamera(); else if
 *      (recording) stopReading()`,而相機在進入步驟 1 後仍是開的 —— 所以錄音中
 *      按 Esc 會去關一個「這一頁看不到的」相機,錄音照跑。修好之後那條衝突路徑
 *      已經不可能發生,這支測試鎖住的是修好後的行為。
 *
 * 相機段需要 mediapipe 的本地 wasm 模型與 fake camera。模型載不出來時(某些
 * 無 GPU 的環境),相機段明確跳過而不是留一條永遠會過的假斷言 —— 但錄音段
 * 不依賴相機,照樣驗。
 *
 * 執行需先 `npm run build`;AI_TP_E2E 由 playwright.config 注入(userData 隔離)。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

async function launch(): Promise<{ app: ElectronApplication; main: Page }> {
  const app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    timeout: 60_000
  })
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  let main = first
  for (let i = 0; i < 40; i++) {
    if (await main.evaluate(() => !!document.querySelector('aside')).catch(() => false)) break
    const cand = app.windows().find((w) => w !== main)
    if (cand && (await cand.evaluate(() => !!document.querySelector('aside')).catch(() => false))) main = cand
    await new Promise((r) => setTimeout(r, 250))
  }
  return { app, main }
}

const navTo = async (main: Page, label: string): Promise<void> => {
  await main.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(l))
    btn?.click()
  }, label)
  await main.waitForTimeout(500)
}

/** 相機是否開著:開了之後「開啟攝影機偵測」會被距離確認鈕取代 */
const cameraOn = (main: Page): Promise<boolean> =>
  main.evaluate(() => {
    const hasOff = [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('開啟攝影機偵測'))
    return !hasOff
  })

const videoLive = (main: Page): Promise<boolean> =>
  main.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement | null
    return !!v?.srcObject
  })

/**
 * 抓住相機的 MediaStreamTrack 並保存參照。
 *
 * 為什麼不只看 UI:步驟切換時 React 會把 <video> 卸掉,所以「畫面回到未開啟」
 * 只證明了 state 變了。真正要驗的是 
 * 「這條 track 已經被 stop」—— 那才是鏡頭指示燈熄滅的原因。
 * 留着參照就能在離開步驟後直接讀 readyState === 'ended'。
 */
const keepTracks = (main: Page): Promise<number> =>
  main.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement | null
    const s = (v?.srcObject ?? null) as MediaStream | null
    const w = window as unknown as { __camTracks?: MediaStreamTrack[] }
    w.__camTracks = s ? s.getTracks() : []
    return w.__camTracks.length
  })

const trackStates = (main: Page): Promise<string[]> =>
  main.evaluate(() => {
    const w = window as unknown as { __camTracks?: MediaStreamTrack[] }
    return (w.__camTracks ?? []).map((t) => t.readyState)
  })

test('離開步驟 0 會關掉相機,Esc 在步驟 1 停止朗讀', async () => {
  test.setTimeout(150_000)
  const { app, main } = await launch()
  try {
    await navTo(main, '個人化校準')

    // ── 相機段:開啟 → Esc 關閉(鍵盤使用者的退出路徑)──
    await main.locator('button', { hasText: '開啟攝影機偵測' }).click()
    let camReady = false
    for (let i = 0; i < 60; i++) {
      if (await cameraOn(main)) {
        camReady = true
        break
      }
      await main.waitForTimeout(500)
    }

    if (camReady) {
      expect(await videoLive(main)).toBe(true)
      expect(await keepTracks(main)).toBeGreaterThan(0)

      // 步驟 0 + 相機開著 → Esc 必須關掉相機(佔用裝置要有鍵盤退出路徑)
      await main.keyboard.press('Escape')
      await main.waitForTimeout(600)
      expect(await cameraOn(main)).toBe(false)
      expect(await videoLive(main)).toBe(false)
      expect(await trackStates(main)).toContain('ended')

      // 再開一次,改走「手動距離繼續」離開步驟 0 → 相機關掉是硬性要求
      await main.locator('button', { hasText: '開啟攝影機偵測' }).click()
      for (let i = 0; i < 60; i++) {
        if (await cameraOn(main)) break
        await main.waitForTimeout(500)
      }
      expect(await cameraOn(main)).toBe(true)
      expect(await keepTracks(main)).toBeGreaterThan(0)
    }

    // ── 用「手動距離」離開步驟 0(不需要距離穩定)──
    await main.locator('input[placeholder="例如 60"]').fill('60')
    await main.locator('button', { hasText: '用手動距離繼續' }).click()
    await main.waitForTimeout(600)
    await expect(main.locator('text=用自然語速朗讀下面這段文字')).toBeVisible({ timeout: 5_000 })

    if (camReady) {
      // 核心斷言:離開步驟 0 必須把相機 track 停掉(鏡頭指示燈熄滅的根據)。
      // 注意不能拿步驟 1 的「有沒有那顆按鈕」當指標 —— 整個步驟 0 的卡片
      // 都不在 DOM 裡,那種寫法量到的是「卡片不存在」而不是「相機關了」。
      expect(await trackStates(main)).toContain('ended')

      // 回步驟 0 再確認 UI 也回到「未開啟」
      await main.locator('button', { hasText: '回上一步' }).click()
      await main.waitForTimeout(500)
      await expect(main.locator('button', { hasText: '開啟攝影機偵測' })).toBeVisible({ timeout: 5_000 })
      expect(await cameraOn(main)).toBe(false)

      // 回到步驟 1 繼續驗 Esc(track 已 ended,所以這裡不必再問相機狀態;
      // 步驟 1 也沒有任何相機 UI 可以當指標)
      await main.locator('button', { hasText: '用手動距離繼續' }).click()
      await main.waitForTimeout(600)
      await expect(main.locator('text=用自然語速朗讀下面這段文字')).toBeVisible({ timeout: 5_000 })
    }

    // ── 步驟 1:Esc 停止朗讀 ──
    // 雲端引擎 + 不存在的端點:不會下載 Whisper 模型,錄音本身與辨識解耦
    await main.evaluate(() =>
      window.api.setSettings({
        stt: { engine: 'cloud', cloud: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'x', model: 'm' } }
      })
    )
    await main.locator('button', { hasText: '開始朗讀' }).click()
    await expect(main.locator('button', { hasText: '唸完了' })).toBeVisible({ timeout: 15_000 })

    await main.keyboard.press('Escape')
    await expect(main.locator('button', { hasText: '開始朗讀' })).toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close().catch(() => undefined)
  }
})
