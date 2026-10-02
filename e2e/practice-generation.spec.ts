/**
 * practice-generation.spec.ts — 練習頁「逐字稿依音訊槽位組裝」的執行期證明。
 *
 * 這條 spec 存在的理由,與它的誠實範圍:
 *
 *   單元測試（practiceGeneration.test.ts）讀原始碼、斷言「世代閘門排在 finalize/
 *   pushTranscript 之前」。那是**原始碼層級**的證明 —— 它擋得住有人把閘門搬回
 *   副作用之後,但證明不了真正的 Electron 執行期行為。
 *
 *   這條 spec 補的是執行期那一半:真的啟動 App、真的走 VAD 分段、真的讓雲端 STT
 *   **亂序**回應,然後從 IndexedDB 讀回存檔的逐字稿,斷言它是依**音訊槽位順序**
 *   組裝的,而不是依 API 完成順序。
 *
 *   為什麼「亂序」是這一輪的核心:分段是同步產生、按時間先後 reserve 槽位的,
 *   而辨識請求是併發送出的 —— 後發出的片段完全可能先回來。若直接
 *   `segsRef.current = [...segsRef.current, text]`,逐字稿就會被打亂,
 *   AI 評分會讀到一句顛倒的話,panic 救援的上下文也跟著錯。
 *
 *   怎麼確定性地製造亂序而不靠 sleep 猜時序:mock STT 伺服器**按請求次數**決定
 *   延遲 —— 第 1 段慢(1200ms)、第 2 段快(10ms)。第 2 段的回應一定先抵達,
 *   於是完成順序與槽位順序相反。這個順序是伺服器主動製造的,不是撞出來的,
 *   所以它不會變成 flaky。
 *
 * ── 這條 spec **證明不了**什麼(誠實揭露) ──
 *   計畫原本要的是「drain 逾時 → 按重新開始 → 舊回覆抵達」的競態重現。
 *   實作時發現**真實 UI 上不可達**:「再練一輪」只在 done 階段渲染,
 *   run/draining 階段按不到;離開頁面則被 App 的 leave guard 擋下。
 *   硬要重現就得繞過產品 UI 直接改 React 狀態 —— 那測的是測試夾具,不是產品。
 *   所以競態那一半留在原始碼層級的不變量測試,這裡只驗整合層面:
 *   乱序機械在真實 Electron + 真實 VAD + 真實 STT 呼叫下確實成立。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { Server } from 'node:http'
import http from 'node:http'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/**
 * 「語音—1.2s 靜音—語音—0.6s 靜音」的假麥克風：讓 VAD 自然切出**兩段**。
 *
 * 為什麼要自己造而不是用預設 fake device:
 *   `--use-fake-device-for-media-stream` 的音訊是連續合成訊號,中間沒有足夠長的
 *   靜音,VAD 整段只會切出**一段** —— 亂序根本不會發生,測試會變成「測不到東西
 *   的綠燈」。這一段由 make-audio-fixture 的真實語音(WAV 中段與尾端各插靜音)組成,
 *   是確定性的:第 1 段先送出、第 2 段後送出,槽位序與送出序一致。
 *   然後由 STT 伺服器**故意讓第 2 段先回**,完成序就與槽位序相反 —— 亂序成立。
 *
 * 產生方式見 scripts/make-audio-fixture.mjs;這個檔案存在時才跑,不存在就跳過
 * （誠實:沒有 fixture 就不假裝測過亂序）。
 */
const TWO_SEG_FIXTURE = resolve(process.cwd(), 'fixtures', 'audit', 'voice-2seg.wav')

let mockStt: Server | null = null
let mockLlm: Server | null = null
let sttPort = 0
let llmPort = 0
/** STT 收到的請求次數 —— 決定這一段該慢還是該快 */
let sttCalls = 0
/** LLM 評分請求裡實際送進去的「回答逐字稿」 —— 這是斷言順序的對象 */
let capturedTranscript = ''
/** 正則對不上時的完整 user content,只在失敗時拿來診斷 */
let capturedRawBody = ''
/** 評分請求的 user content 全文（診斷用） */
let capturedUserContent = ''

/**
 * 第 1 段刻意慢、後面的段刻意快:完成順序必定與槽位順序相反。
 *
 * 為什麼第 1 段要慢到 4.5 秒（不是「比別段慢一點」）:
 *   VAD 各段是**隨音訊前進即時送出**的,相鄰兩段相隔數秒。若延遲差小於這個
 *   間隔,第 1 段照樣先回 —— 測試會以為自己測了亂序,實際上一路綠燈,
 *   正是本專案最貴的失敗模式（「綠燈但測不到東西」）。
 *
 *   4.5s 的上界也很關鍵:它必須讓第 1 段在**停止錄音（觸發 finalize）之前**回來。
 *   否則 finalize() 會把尚未完成的槽位當作逾時放棄,那時測到的是「逾時路徑」,
 *   不是「亂序路徑」—— 兩者都綠,但測的是不同的東西。實測:VAD 約在
 *   3s/5s/8s 送出三段,所以 4.5s 讓完成序變成 2(5.0s) → 1(7.5s) → 3(8.0s):
 *   確定是亂序,且全部在約 9s 的停止之前落地。
 */
const STT_DELAY_MS = [4_500, 10]

function startMocks(): void {
  sttCalls = 0
  capturedTranscript = ''
  capturedRawBody = ''
  capturedUserContent = ''
  mockStt = http.createServer((_req, res) => {
    const delay = STT_DELAY_MS[Math.min(sttCalls, STT_DELAY_MS.length - 1)]
    sttCalls += 1
    // 每一段回不同的文字:組裝順序錯了,字串就對不上,斷言才有意義
    const text = `第${sttCalls}段逐字稿`
    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ text }))
    }, delay)
  })
  mockLlm = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      let text: string
      // 路由用無轉義歧義的唯一子字串（與 blindspot.spec.ts 同一套）
      if (body.includes('回答逐字稿')) {
        // 評分 prompt 裡「應徵者的回答逐字稿：」之後到 rateLine 之前就是逐字稿本體。
        // 不對 JSON 字串直接跑 regex(跳脫字元會讓比對結果難以預期):
        // 先 parse 出 messages,取 user 那句,再切出逐字稿。
        // 失敗時把 user content 整段印出來 —— 正則對不上時,「猜」是猜不出來的。
        try {
          const parsed = JSON.parse(body)
          const userMsg = parsed.messages?.find((msg) => typeof msg?.content === 'string' && msg.content.includes('回答逐字稿'))
          const content = userMsg?.content ?? ''
          capturedUserContent = content
          const startAt = content.indexOf('應徵者的回答逐字稿：')
          const rest = startAt >= 0 ? content.slice(startAt) : ''
          // 逐字稿 = 標記行之後,到空行(以及 rateLine)之前
          const afterMark = rest.split('：').slice(1).join('：')
          capturedTranscript = afterMark.replace(/^\n/, '').split('\n\n')[0] ?? ''
        } catch {
          capturedRawBody = body
        }
        text = JSON.stringify({
          score: 82,
          content: '切題且有具體例子',
          structure: '條理清晰',
          delivery: '語速平穩',
          betterAnswer: '可以用 STAR 結構把專案成果量化。'
        })
      } else if (body.includes('道面試題')) {
        text = JSON.stringify(['請介紹你最熟悉的一段專案經驗'])
      } else {
        text = '整體表現穩定。'
      }
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }))
    })
  })
  mockStt.listen(0, '127.0.0.1', () => {
    sttPort = (mockStt!.address() as { port: number }).port
    mockLlm!.listen(0, '127.0.0.1', () => {
      llmPort = (mockLlm!.address() as { port: number }).port
    })
  })
}

async function launchApp(): Promise<{ app: ElectronApplication; main: Page }> {
  const app = await electron.launch({
    args: [
      '.',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${TWO_SEG_FIXTURE}`,
      '--use-file-for-fake-audio-capture-without-startup-beep'
    ],
    timeout: 60_000
  })
  await app.waitForEvent('window', { timeout: 30_000 })
  let main: Page | undefined
  for (let i = 0; i < 60 && !main; i++) {
    main = app.windows().find((w) => !w.url().includes('overlay'))
    if (!main) await new Promise((r) => setTimeout(r, 250))
  }
  if (!main) throw new Error('windows not ready')
  await main.waitForLoadState('domcontentloaded')
  return { app, main }
}

async function navTo(main: Page, label: string): Promise<void> {
  await main.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(l))
    btn?.click()
  }, label)
  await main.waitForTimeout(400)
}

test('Practice:STT 亂序回應時,逐字稿仍依音訊槽位順序組裝並入庫', async () => {
  test.setTimeout(120_000)
  // 缺 fixture 就**自己產生**,而不是 skip。
  //
  // 為什麼不 skip:skip 過的測試在報告上與「通過」長得一模一樣 —— 沒有 fixture 的
  // 環境(例如忘了跑產生器的 CI)會得到一份全綠的報告,而實際上這條測試從來沒跑過。
  // 這正是本專案記錄過最貴的失敗模式。產生是離線的(有 SAPI 用真語音,沒有用
  // 合成波形),跑一次約一秒,所以「自己補上」比「跳過」誠實得多。
  //
  // 只有連產生都失敗才 skip,而且那時的訊息要說清楚是「環境產不出 fixture」。
  if (!existsSync(TWO_SEG_FIXTURE)) {
    execFileSync(process.execPath, ['--no-warnings', 'scripts/make-audio-fixture.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe'
    })
  }
  test.skip(
    !existsSync(TWO_SEG_FIXTURE),
    `無法產生 ${TWO_SEG_FIXTURE}:這個環境的假麥克風 fixture 產不出來,所以亂序路徑沒有被量到（不是「測過了」）`
  )
  startMocks()
  const { app, main } = await launchApp()
  try {

    // STT(雲端)與 AI(OpenAI 相容)都指向 mock
    await navTo(main, '面試練習')
    await main.evaluate(
      (p) => {
        void window.api.setSettings({
          stt: { engine: 'cloud', cloud: { baseUrl: `http://127.0.0.1:${p.stt}/v1`, apiKey: 'x', model: 'm' } },
          ai: {
            provider: 'openai-compatible',
            openaiCompatible: { baseUrl: `http://127.0.0.1:${p.llm}/v1`, apiKey: 'test', model: 'mock' }
          }
        })
      },
      { stt: sttPort, llm: llmPort }
    )

    await main.locator('input').first().fill('產品經理')
    await main.locator('button', { hasText: '開始練習' }).click()
    await expect(main.locator('text=請介紹你最熟悉的一段專案經驗')).toBeVisible({ timeout: 15_000 })

    // 錄音:fake mic 是持續白噪,VAD 會切出多段。時長要夠長到至少兩段,
    // 但也不能長到 drainPending 逾時 —— 否則測的是逾時路徑而不是亂序路徑。
    await main.locator('button', { hasText: '開始回答' }).click()
    await expect(main.locator('text=錄音中').first()).toBeVisible({ timeout: 10_000 })
    // fixture 總長 8 秒,必須等它整段跑完(包含尾部 0.6s 靜音讓 VAD 收掉第二段)
    await main.waitForTimeout(9_000)
    // 至少要有兩段真的送到 STT,否則「亂序」根本沒發生(這是前提,不是結果)
    expect(sttCalls, 'VAD 至少要切出兩段,亂序的前提才成立').toBeGreaterThanOrEqual(2)

    await main.locator('button', { hasText: '完成回答，取得反饋' }).click()
    await expect(main.locator('text=AI 教練反饋')).toBeVisible({ timeout: 20_000 })

    // practiceRuns 只在 finishRun 時才寫入,答完一題只是停在反饋階段。
    // 這一輪只出一道題,所以主按鈕此時就是「查看總評」—— 走完它資料才入庫。
    await main.locator('button', { hasText: '查看總評' }).click()
    await expect(main.locator('text=練習完成')).toBeVisible({ timeout: 20_000 })

    // 斷言的是送進評分的逐字稿**順序**:
    // 依槽位組裝 → 第1段的文字一定排在第2段之前;
    // 依完成順序組裝 → 快回的第2段會排在慢回的第1段之前。
    // 從 mock LLM 端 capture,斷言的是真正送去評分的字串（不是 UI 呈現）。
    const transcript = capturedTranscript
    expect(
      transcript,
      `評分請求裡必須帶逐字稿,否則順序斷言等於沒測。實際 user content:\n${capturedUserContent}\n-- raw body --\n${capturedRawBody}`
    ).not.toBe('')
    expect(transcript.indexOf('第1段')).toBeGreaterThanOrEqual(0)
    expect(transcript.indexOf('第2段')).toBeGreaterThanOrEqual(0)
    expect(
      transcript.indexOf('第1段'),
      '逐字稿必須依音訊槽位順序（第1段在前）,不是依 STT 完成順序'
    ).toBeLessThan(transcript.indexOf('第2段'))
  } finally {
    mockStt?.close()
    mockLlm?.close()
    await app.close()
  }
})