/**
 * e2eFaults.ts — 在**邊界**注入麥克風故障,不碰產品邏輯。
 *
 * ── 為什麼只有麥克風在這裡 ──
 *   Ollama 的注入在 main 端(見 src/main/ollama.ts)。原因是 contextBridge
 *   凍結了 window.api —— 在 renderer 裡改寫 `window.api.ollamaListModels`
 *   會丟 TypeError,而那發生在 main.tsx 的**模組層級**,於是整個入口檔中止、
 *   頁面全白、連側欄都沒有(preflight.ts 的檔頭記錄了這個實測)。
 *
 *   而 main 端注入反而更好:preflight 與設定頁「測試連線」兩個呼叫點
 *   都會看到同一個故障,而不只是其中一個。
 *
 * ── 為什麼在這裡、而不是改產品程式碼 ──
 *   如果為了測試去改 Record.tsx 的 getUserMedia 呼叫,被測到的就不再是產品。
 *   量測層必須能推進狀態,卻不能改變被量的東西(同一個理由見 lib/auditBridge.ts)。
 *
 * ── 注入點為什麼是 getUserMedia ──
 *   它是「麥克風可用性」的唯一入口:權限被拒、裝置不存在、裝置被占用,
 *   在 Chromium 裡全部是**這一個函式**丟出的三種錯誤名。
 *
 * ── 安全邊界 ──
 *   只在 main 回報的 e2eEnv 不是預設值時才動手,而打包版的 e2eEnv 一定是
 *   預設(見 src/main/debug.ts 的 E2E_ENV)。
 *   重複呼叫安全:第二次是 no-op,避免 React 掛載兩次時疊兩層包裝。
 */
import type { E2EEnv } from '@shared/e2eEnv'

let installed = false

/**
 * Chromium 對這三種情況丟出的錯誤名。
 *
 * **必須用同樣的名字**:describeError 是靠 `err.name` 比對的。我們自己發明
 * 一個名字的話,E_MIC_PERMISSION_DENIED / E_MIC_BUSY / E_MIC_NOT_FOUND
 * 三段文案整組都不會被觸發 —— 而那正是這個檔案要驗的東西。
 *
 * 名稱取自 Chromium 的 MediaStreamError:
 *   NotAllowedError       權限被拒(或被使用者封鎖)
 *   NotReadableError      裝置存在但無法讀取(被占用、硬體被別的程式拿走)
 *   DevicesNotFoundError  找不到符合條件的裝置
 */
function micError(name: 'NotAllowedError' | 'NotReadableError' | 'DevicesNotFoundError'): Error {
  const messages: Record<string, string> = {
    NotAllowedError: 'Permission denied',
    NotReadableError: 'Could not start audio source',
    DevicesNotFoundError: 'Requested device not found'
  }
  // name 與 message 是分開的兩個欄位,而 Error 的 name 可寫 —— 顯式設定,
  // 避免將來有人收緊建構子或加上 subclass 而失效。
  const e = new Error(messages[name])
  e.name = name
  return e
}

/** 這個情境要丟什麼;null = 不注入。 */
function micFaultFor(env: E2EEnv): Error | null {
  if (env.mic === 'denied') return micError('NotAllowedError')
  if (env.mic === 'busy') return micError('NotReadableError')
  if (env.mic === 'not-found') return micError('DevicesNotFoundError')
  return null
}

/**
 * 依情境安裝故障注入。
 *
 * 回傳「實際注入了什麼」給呼叫端印出來:一個跑在假世界裡的測試,
 * 失敗訊息裡沒有這行字就會被誤讀成產品缺陷 —— 這是量測層說謊最常見的形狀。
 */
export function installE2EFaults(env: E2EEnv): string[] {
  const applied: string[] = []
  if (installed) return applied

  const micFault = micFaultFor(env)
  if (micFault) {
    const md = navigator.mediaDevices
    // 邊界檢查:沒有 mediaDevices 的環境直接不注入。靜默注入一個**不會生效**
    // 的故障比不注入更糟 —— 測試會以為自己測到了拒絕路徑,實際上走的是
    // 正常路徑,而那正是「量到了不是使用者所見」。
    if (md && typeof md.getUserMedia === 'function') {
      md.getUserMedia = (): Promise<MediaStream> => Promise.reject(micFault)
      applied.push(`getUserMedia → ${micFault.name}`)
    }
  }

  if (applied.length > 0) installed = true
  return applied
}

/** 測試用:清掉「已安裝」旗標,讓 installE2EFaults 可以在同一個程序裡重跑。 */
export function __resetE2EFaults(): void {
  installed = false
}