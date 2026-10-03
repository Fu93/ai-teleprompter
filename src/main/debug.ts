import { app } from 'electron'
import {
  E2E_ENV_DEFAULT,
  parseMicScenario,
  parseOllamaScenario,
  type E2EEnv
} from '@shared/e2eEnv'

/**
 * debug.ts — 開發者除錯能力的單一開關。
 *
 * 為什麼不能只看 `!app.isPackaged`:
 *   e2e(smoke / visual / playtest)與 scripts/audit-*.mjs 都是以「未打包」的
 *   Electron 啟動,`!app.isPackaged` 在那裡恆為真。若只用這個條件,除錯 UI 會
 *   混進稽核截圖與 DOM 稽核 —— 而 DOM 稽核本身會把除錯面板的外框、小按鈕
 *   當成缺陷報出來,量到的就不是使用者所見。這個專案已經吃過一次
 *   「量測到非使用者所見」的虧(audit-deep.mjs 開頭寫得很清楚)。
 *
 * 因此:
 *   - `AI_TP_DEBUG=1`:明確要求,任何環境都生效(包含打包後的安裝包,
 *     供使用者端疑難排解時由開發者指示開啟)。
 *   - 未打包、且不是 e2e:開發日常(`npm run dev`)直接就有,不必記環境變數。
 *
 * 注意:這裡只決定「能力是否存在」。除錯面板/HUD 預設是關閉的,
 * 要按 Ctrl+Shift+D 才會出現,所以即使存在也不會影響既有截圖。
 */
export const DEBUG =
  process.env['AI_TP_DEBUG'] === '1' ||
  (!app.isPackaged && process.env['AI_TP_E2E'] !== '1')

/**
 * AUDIT — 給稽核腳本用的「狀態強制」能力,與 DEBUG 刻意分開。
 *
 * 為什麼不能直接用 DEBUG:
 *   scripts/audit-*.mjs 以 AI_TP_E2E=1 啟動(見 src/main/index.ts 的 userData
 *   重導),而 DEBUG 在那裡是「刻意關閉」的 —— 它會把除錯面板與 HUD 掛進 DOM,
 *   而 DOM 稽核會把那些外框與小按鈕當成缺陷報出來,量到的就不是使用者所見。
 *
 * 但稽核需要另一種東西:把 App 強制推進到 headless 到不了的狀態。
 * 最明顯的例子是「個人化校準」的第 1/2 步 —— 第一步要有相機或手動距離,
 *   第二步要有麥克風量測出來的語速,而稽核環境兩者都沒有。上一輪的稽核腳本
 *   用文字 regex 找「下一步」按鈕再點下去,找不到就靜默 no-op,結果 step1
 *   與 step2 的截圖與原始頁面 sha256 完全相同 —— 深狀態從未被量測,
 *   而報告仍是一份漂亮的空清單。
 *
 * 所以:
 *   - AUDIT 只開啟「狀態強制橋」(window.__auditForce),不掛任何可見 UI。
 *   - 一樣只在未打包時成立:安裝包裡不存在這條路徑。
 */
export const AUDIT = !app.isPackaged && process.env['AI_TP_AUDIT'] === '1'

/**
 * E2E — e2e 隔離旗標。與 DEBUG / AUDIT 分開,因為它管的是**測試資料隔離**
 * (userData 重導到暫存目錄,見 src/main/index.ts),不是能力開關。
 */
export const E2E = !app.isPackaged && process.env['AI_TP_E2E'] === '1'

/**
 * E2E_ENV — e2e 的環境故障注入情境(麥克風、Ollama)。
 *
 * ── 這是安全邊界,不是謹慎 ──
 *   它會讓 `getUserMedia` 丟出假的 NotAllowedError、讓 Ollama 的
 *   `/api/tags` 失敗。如果它在打包版裡有可能為 true,使用者在正式安裝包上
 *   按「開始錄音」會拿到「麥克風權限被拒」—— 而他會**照著指示**去 Windows
 *   設定裡改權限,那是��難察覺的一種信任背書。
 *
 *   所以條件與 AUDIT 完全相同(未打包 **且** 明確要求),而不是「未打包就當
 *   預設注入」:預設值必須是乾淨的,否則每一個 e2e 都會在一個有假故障的
 *   世界裡跑,而那種偏差不會讓任何一條測試失敗。
 */
export const E2E_ENV: E2EEnv = E2E
  ? {
      mic: parseMicScenario(process.env['AI_TP_E2E_MIC']),
      ollama: parseOllamaScenario(process.env['AI_TP_E2E_OLLAMA'])
    }
  : E2E_ENV_DEFAULT
