/**
 * e2eEnv.ts — e2e 的**環境情境**契約(麥克風、Ollama),main 與 renderer 共用。
 *
 * ── 為什麼需要這個檔 ──
 *   「麥克風權限被拒」與「Ollama 沒開」是使用者最常撞到的兩面牆,而它們
 *   **完全沒有自動化覆蓋** —— 不是沒人想測,是真的測不到:
 *   - 麥克風權限是 OS 層級的。CI 沒有麥克風,就算有,測試程序也拿不到
 *     使用者的授權狀態。
 *   - Ollama 要真的在本機跑一個服務並下載幾百 MB 的模型。
 *
 *   於是 E_MIC_PERMISSION_DENIED / E_MIC_BUSY / E_MIC_NOT_FOUND 這三個
 *   錯誤碼與它們對應的三段文案,在 shared/errorCodes.ts 裡寫好了卻**永遠
 *   沒有被執行過一次**。而 describeError 的整個存在理由就是「使用者撞到的
 *   第一面牆要有人陪」—— 一條沒有被驗過的翻譯,很可能翻錯了而不會有人知道。
 *
 * ── 邊界:這是**故障注入**,不是模擬器 ──
 *   注入點在 getUserMedia 與 fetch 的**邊界**,產品程式碼一行都不用改。
 *   這與 auditBridge 是同一個理由:如果為了測試去改產品程式碼,
 *   被測到的就不再是產品了。
 *
 * ── 打包版永遠拿得到 false ──
 *   這是安全邊界,不是謹慎:[E2E_ENV] 的每一個欄位都由
 *   `!app.isPackaged && process.env.AI_TP_E2E === '1'` 保護(見 debug.ts 的 E2E)。
 *   一旦這個條件寫錯,使用者按下「開始錄音」會拿到一個假的 NotAllowedError,
 *   而他會照著去 Windows 設定裡改權限 —— 那是最難察覺的一種信任背書。
 */
/** 麥克風情境。'ok' 是預設(不注入任何東西)。 */
export type MicScenario = 'ok' | 'denied' | 'busy' | 'not-found'

/** Ollama 情境。'ok' 是預設。 */
export type OllamaScenario = 'ok' | 'down' | 'no-model'

export interface E2EEnv {
  mic: MicScenario
  ollama: OllamaScenario
}

/** 預設值:什麼都不注入。 */
export const E2E_ENV_DEFAULT: E2EEnv = { mic: 'ok', ollama: 'ok' }

/**
 * 解析環境變數字串。
 *
 * **刻意不驗證值** —— 未知值一律退回 'ok',而不是丟錯。
 *
 * 理由:這是測試端的輸入,而「打錯一個字」不該讓整個 e2e 掛掉。
 * 但它也不該靜默地把「我要測麥克風被拒」變成「測正常路徑」——
 * 所以 E2E_ENV_VOCABULARY 是匯出來的常數,測試可以對照,
 * 而 CI 上多一條 spec 失敗時,診斷訊息會直接印出讀到的值。
 */
export function parseMicScenario(raw: string | undefined | null): MicScenario {
  const v = String(raw ?? '').trim().toLowerCase()
  return v === 'denied' || v === 'busy' || v === 'not-found' ? v : 'ok'
}

export function parseOllamaScenario(raw: string | undefined | null): OllamaScenario {
  const v = String(raw ?? '').trim().toLowerCase()
  return v === 'down' || v === 'no-model' ? v : 'ok'
}

/** 這個情境有沒有注入任何東西。 */
export function isFaultInjected(env: E2EEnv): boolean {
  return env.mic !== 'ok' || env.ollama !== 'ok'
}

/** 給失敗訊息用:一眼看出這條測試跑在哪個世界裡。 */
export function describeEnv(env: E2EEnv): string {
  return `mic=${env.mic} ollama=${env.ollama}`
}