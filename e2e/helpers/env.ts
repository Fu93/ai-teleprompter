/**
 * env.ts — e2e 的**環境情境**啟動器(麥克風、Ollama)。
 *
 * ── 解決什麼問題 ──
 *   「麥克風權限被拒」與「Ollama 沒開」是使用者最常撞到的兩面牆,而它們
 *   在 CI 上測不到:麥克風權限是 OS 層級的,Ollama 要真的跑服務並下載幾百 MB
 *   模型。結果是 E_MIC_PERMISSION_DENIED / E_MIC_BUSY / E_MIC_NOT_FOUND
 *   三個錯誤碼與它們的三段文案,**從來沒有被執行過一次**。
 *
 *   而「使用者撞到的第一面牆要有人陪」正是 describeError 存在的理由。
 *   一條沒有被驗過的翻譯很可能翻錯了,而不會有人知道。
 *
 * ── 用法 ──
 *   const { app, main } = await launchApp(e2eEnv({ mic: 'denied' }))
 *
 *   預設**不注入任何東西**。這一點是刻意的:預設乾淨才不會讓每一個 e2e
 *   都在一個有假故障的世界裡跑 —— 那種偏差不會讓任何一條測試失敗,
 *   只會讓「麥克風測試通過了」變成一個無法解讀的結果。
 *
 * ── 安全邊界 ──
 *   這些變數只有在 `!app.isPackaged && AI_TP_E2E=1` 時才會被讀
 *   (見 src/main/debug.ts 的 E2E_ENV)。打包版裡 `E2E_ENV` 永遠是預設值,
 *   使用者在正式安裝包上按下「開始錄音」不會拿到假的權限錯誤。
 */
import { describeEnv, type E2EEnv } from '../../src/shared/e2eEnv'

export interface LaunchEnvOptions extends Partial<E2EEnv> {
  /**
   * 順便開 audit 橋(window.__auditForce)。
   *
   * 預設 false:稽核橋不掛任何可見 UI,但它確實多一條路徑,
   * 讓「測試量到的不是使用者所見」變成有可能。真的要狀態強制時再開。
   */
  audit?: boolean
}

/**
 * 組出給 electron.launch 的 env。
 *
 * 刻意**不覆寫** `process.env` 的其他鍵:Electron 子程序需要繼承 PATH、
 * TEMP、SYSTEMROOT,少一個就是「測試在沒人見過的機器上跑」。
 */
export function e2eEnv(opts: LaunchEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string | undefined>),
    AI_TP_E2E: '1'
  }
  // 只在明確指定時才寫變數。不指定就不寫,讓 parseMicScenario 走預設 'ok' ——
  // 兩條路都得到 'ok',但寫出變數會讓「這條測試有沒有要注入」變得看不出來。
  if (opts.mic && opts.mic !== 'ok') env.AI_TP_E2E_MIC = opts.mic
  if (opts.ollama && opts.ollama !== 'ok') env.AI_TP_E2E_OLLAMA = opts.ollama
  if (opts.audit) env.AI_TP_AUDIT = '1'
  return env
}

/**
 * 給測試輸出用的一行摘要,讓失敗訊息裡看得出「這條測試跑在哪個世界裡」。
 *
 * 沒有它的話,一個因為注入故障而失敗的測試會被讀成產品缺陷 ——
 * 這是量測層說謊最常見的形狀,而且它每次都長得像真的。
 */
export function envSummary(opts: LaunchEnvOptions = {}): string {
  return `[e2e env] ${describeEnv({ mic: opts.mic ?? 'ok', ollama: opts.ollama ?? 'ok' })}`
}