/**
 * bootstrap.ts — renderer 掛載前的啟動步驟,與 React 分離。
 *
 * ── 為什麼要抽出來 ──
 *   原本這段在 main.tsx 裡:
 *
 *     void window.api?.appInfo()?.then((info) => { installE2EFaults(...) })
 *     ReactDOM.createRoot(...).render(<App />)          // 同步,沒有等上面
 *
 *   而旁邊的註解寫著「這一段要在 React 掛載**之前**完成(否則第一個頁面
 *   可能已經在呼叫 getUserMedia 了)」。**程式碼並沒有做到這件事。**
 *   `appInfo()` 是一次 IPC 往返,而 render 緊接著同步執行 —— 沒有任何保證。
 *
 *   當時之所以沒事,是因為 e2e 裡每一條相關的測試都寫了
 *   `waitForTimeout(1200)` 硬等。那是把一個**競態**用 sleep 蓋住:
 *   測試綠,不代表注入先於掛載 —— 只代表 sleep 夠長。
 *
 * ── 這裡保證什麼 ──
 *   `runBootstrap()` 是一個可 await 的函式,回傳之後才 render。
 *   於是「故障注入先於第一個頁面掛載」從一個註解變成一個順序事實。
 *
 * ── 為什麼不用同步注入 ──
 *   另一條路是把 e2eEnv 從 preload 同步掛成 window 常數,注入完全不需要 IPC。
 *   沒選它:那會讓 debug/量測的旗標進入正式安裝包的全域命名空間,
 *   而安全邊界正是「打包版的 e2eEnv 一定是預設值」這句話(見 main/debug.ts)。
 *   等一次 IPC 的成本是一次本地往返,而好處是這個邊界不動。
 */
import { installE2EFaults } from './e2eFaults'
import { installToastBridge } from './auditBridge'
import { toast } from './toast'
import type { AppInfo } from '@shared/types'
import type { E2EEnv } from '@shared/e2eEnv'

export interface BootstrapResult {
  /** 實際注入了什麼環境故障;空陣列 = 乾淨環境(正式使用者的情況) */
  applied: string[]
  /** toast 橋是否已掛上(audit 模式) */
  toastBridge: boolean
}

/** 預設環境:與 main/debug.ts 的 E2E_ENV 同形 —— 什麼都不注入。 */
const CLEAN_ENV: E2EEnv = { mic: 'ok', ollama: 'ok' }

/**
 * 掛載前必須完成的步驟。
 *
 * 刻意**不** try/catch 成「失敗就繼續」:appInfo() 掛掉時預設值就是乾淨環境,
 * 而乾淨環境不需要任何處理 —— 但它必須是**明確決定**的乾淨,不是意外。
 * 真的有問題時 `warn` 會出現在主控台,稽核模式下的失敗訊息看得到它。
 */
export async function runBootstrap(
  fetchInfo: () => Promise<AppInfo | null | undefined> | undefined,
  warn: (message: string) => void = (m) => console.warn(m)
): Promise<BootstrapResult> {
  let info: AppInfo | null | undefined = null
  try {
    info = await fetchInfo()
  } catch (err) {
    warn(`[bootstrap] 讀取 appInfo 失敗,以乾淨環境啟動:${err instanceof Error ? err.message : String(err)}`)
  }

  let toastBridge = false
  if (info?.audit) {
    installToastBridge((kind, message, action) => toast[kind](message, action))
    toastBridge = true
  }

  // 麥克風故障。Ollama 的注入在 main 端(見 src/main/ollama.ts)。
  const applied = installE2EFaults(info?.e2eEnv ?? CLEAN_ENV)
  if (applied.length > 0) {
    // 印出來:一個跑在假世界裡的測試,失敗訊息裡有這行字才知道不是產品缺陷。
    warn(`[e2e] 已注入環境故障:${applied.join(', ')}`)
    // 同時掛成一個可查詢的旗標。理由:console.warn 要靠監聽 console 事件才拿得到,
    // 而 e2e 需要的是「注入確實發生了」這個**可輪詢的事實** —— 它取代了
    // mic-denied.spec.ts 原本的 waitForTimeout(1200)。
    // 與 __auditForce 同一個安全邊界:這段程式碼只在 info.audit 時有作用,
    // 正式安裝包的 e2eEnv 恆為預設值,applied 恆為空陣列,所以不會掛任何東西。
    if (info?.audit && typeof window !== 'undefined') {
      ;(window as unknown as { __injectedFaults?: string[] }).__injectedFaults = applied
    }
  }

  return { applied, toastBridge }
}
