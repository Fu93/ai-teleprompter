/**
 * blindspot.spec.ts — 校準 / Practice / 貼鏡 完整旅程回歸測試
 * (上輪 user-journey 未覆蓋的三條盲區路徑)
 *
 * 前提:npm run build;AI_TP_E2E=1 由 playwright.config 注入(userData 隔離)。
 * 校準以「手動距離 + mock STT server」走完(真 face-landmarker 為本地 wasm+model,
 * fake camera 無臉 → 自動走手動路徑);Practice 以 openai-compatible provider
 * 指向 mock LLM server 走完(出題/反饋/總評三路由);貼鏡以工具列實際進出驗還原。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { Server } from 'node:http'
import http from 'node:http'

let mockStt: Server | null = null
let mockLlm: Server | null = null
let sttPort = 0
let llmPort = 0

/** 迷你 mock:STT 回逐字稿;LLM 依 prompt 關鍵字回題目/反饋 JSON/總評 */
function startMocks(): void {
  mockStt = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ text: '我們的產品願景是幫助每個人在重要場合自信表達並且建立長期的溝通信心與表達能力' }))
  })
  mockLlm = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      let text: string
      // 路由用無轉義歧義的唯一子字串:
      // 反饋 prompt 獨有「回答逐字稿」;出題 prompt 獨有「道面試題」;總評 prompt 走 else
      if (body.includes('回答逐字稿')) {
        text = JSON.stringify({ score: 82, content: '切題且有具體例子', structure: '條理清晰', delivery: '語速平穩', betterAnswer: '可以用 STAR 結構把專案成果量化,結尾連結到應徵職位的需求。' })
      } else if (body.includes('道面試題')) {
        text = JSON.stringify(['請介紹你最熟悉的一段專案經驗', '你如何處理與同事的意見衝突'])
      } else {
        text = '整體表現穩定,建議加強量化成果與結尾收束。'
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { content: text } }]
        })
      )
    })
  })
  mockStt.listen(0, '127.0.0.1', () => {
    sttPort = (mockStt!.address() as { port: number }).port
    mockLlm!.listen(0, '127.0.0.1', () => {
      llmPort = (mockLlm!.address() as { port: number }).port
    })
  })
}

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
  if (!main || !overlay) throw new Error('windows not ready')
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

test('校準 + Practice + 貼鏡 盲區巡檢', async () => {
  test.setTimeout(180_000)
  startMocks()
  const { app, main, overlay } = await launchApp()
  try {
    // ── A. 校準:手動距離 + mock 轉錄 ──
    await navTo(main, '個人化校準')
    await main.locator('input[placeholder="例如 60"]').fill('60')
    await main.locator('button', { hasText: '用手動距離繼續' }).click()
    await main.waitForTimeout(300)
    // Step 2 語速:設雲端引擎指 mock,開始朗讀 6s(fake mic 白噪)後「唸完了」
    await main.evaluate((p) => {
      void window.api.setSettings({
        stt: { engine: 'cloud', cloud: { baseUrl: `http://127.0.0.1:${p}/v1`, apiKey: 'x', model: 'm' } }
      })
    }, sttPort)
    await main.locator('button', { hasText: '開始朗讀' }).click()
    await main.waitForTimeout(6_000)
    await main.locator('button', { hasText: '唸完了' }).click()
    // mock 轉錄 ≥20 字 → 應出現結果而非錯誤
    await expect(main.locator('text=字/分').first()).toBeVisible({ timeout: 10_000 })
    await main.locator('button', { hasText: '下一步' }).click()
    await main.waitForTimeout(300)
    await main.locator('button', { hasText: '套用個人化設定' }).click()
    // onDone → 導回設定頁;profile 應已寫入
    const profile = await main.evaluate(async () => (await window.api.getSettings()).personal.profile)
    expect(profile).toBeTruthy()
    expect((profile as { viewingDistanceCm: number }).viewingDistanceCm).toBe(60)
    expect((profile as { charsPerMin: number }).charsPerMin).toBeGreaterThan(0)

    // ── B. Practice 全流程 ──
    await navTo(main, '面試練習')
    await main.evaluate((p) => {
      void window.api.setSettings({
        ai: { provider: 'openai-compatible', openaiCompatible: { baseUrl: `http://127.0.0.1:${p}/v1`, apiKey: 'test', model: 'mock' } }
      })
    }, llmPort)
    await main.locator('input').first().fill('產品經理')
    await main.locator('button', { hasText: '開始練習' }).click()
    // 產生題目 → 進入 run
    await expect(main.locator('text=請介紹你最熟悉的一段專案經驗')).toBeVisible({ timeout: 15_000 })
    // 開始回答( fake mic )→ 完成回答 → mock 反饋
    await main.locator('button', { hasText: '開始回答' }).click()
    await main.waitForTimeout(5_000)
    // 按鈕文案用全形逗號
    await main.locator('button', { hasText: '完成回答，取得反饋' }).click()
    await expect(main.locator('text=AI 教練反饋')).toBeVisible({ timeout: 15_000 })
    // 第二題:完成回答 → 反饋後的下一題按鈕名為「查看總評」→ finishRun
    await main.locator('button', { hasText: '下一題' }).click()
    await main.waitForTimeout(400)
    await main.locator('button', { hasText: '開始回答' }).click()
    await main.waitForTimeout(3_000)
    await main.locator('button', { hasText: '完成回答，取得反饋' }).click()
    // 第二題反饋:等反饋按鈕恢復為「查看總評」= 反饋完成
    await expect(main.locator('button', { hasText: '查看總評' })).toBeVisible({ timeout: 15_000 })
    await main.locator('button', { hasText: '查看總評' }).click()
    await expect(main.locator('text=整體表現穩定')).toBeVisible({ timeout: 15_000 })

    // ── C. 貼鏡:進出與還原 ──
    await navTo(main, '提詞講稿')
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('新講稿'))
      btn?.click()
    })
    await main.waitForTimeout(300)
    await main
      .locator('textarea')
      .fill(Array.from({ length: 8 }, (_, i) => `第${i + 1}點,產品願景幫助每個人在重要場合自信表達並建立長期信心。`).join('\n'))
    await main.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('開始提詞'))
      btn?.click()
    })
    await expect(overlay.locator('[title^="暫停"]')).toHaveCount(1, { timeout: 5_000 })
    await overlay.locator('[title^="貼鏡模式"]').click()
    await overlay.waitForTimeout(1_200)
    // 進貼鏡:420x170、lens 工具列存在
    const size = await overlay.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)
    expect(size).toBe('420x170')
    await expect(overlay.locator('[title="退出貼鏡模式"]')).toHaveCount(1)
    await overlay.locator('[title="退出貼鏡模式"]').click()
    await overlay.waitForTimeout(1_200)
    const back = await overlay.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)
    expect(back).not.toBe('420x170')
  } finally {
    mockStt?.close()
    mockLlm?.close()
    await app.close()
  }
})
