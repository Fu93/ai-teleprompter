/**
 * diagnostics.ts — 「複製診斷報告」的內容組成。
 *
 * 這份報告存在的唯一理由:讓「回報問題」從「貼一段沒有上下文的日誌」變成
 * 「貼一份能直接回答九成問題的摘要」。回報者最常卡住的三個問題是:
 *   1. 他用的是哪個引擎?(本地 Whisper 還是雲端 STT)
 *   2. AI 連到哪裡?(本機 Ollama 還是某個雲端服務)
 *   3. 這台機器上出過什麼錯?(錯誤碼與次數)
 * 這三件事原本在 main.log 裡**完全不存在** —— 日誌記的是過程,不是環境。
 *
 * ── 遮蔽不是「小心」,是這個功能的成敗條件 ──
 *   診斷報告唯一的傳遞方式就是使用者複製貼到公開的 issue 上。也就是說它的
 *   內容預設會**離開這台電腦**。所以遮蔽規則必須寫成單元測試,而不是註解:
 *   一份「不會洩漏」的宣稱如果沒有測試,等於沒有宣稱。
 *   見 __tests__/diagnostics.test.ts 對每一個欄位名稱的斷言。
 *
 * ── 這裡不做的事 ──
 *   不放逐字稿、不放講稿內容、不放金鑰、不放個人校準的實際數值(眼距是
 *   個人生理特徵,除錯不需要)。放的是「會影響行為的旗標」。
 */
import { app } from 'electron'
import type { AppSettings } from '@shared/types'
import { endpointHost, type DiagnosticsReport } from '@shared/observability'
// formatDiagnosticsReport 住在 shared/observability.ts(而不是這裡):
// renderer 的設定頁也要用它,而這個檔案 import 了 electron 的 `app` ——
// 讓前端匯入它會把整個 electron 模組拖進 bundle。
import { recentErrorCounts, recentEvents } from './events'

/**
 * 設定摘要:只放會影響診斷的欄位。
 *
 * 刻意**逐項列出**而不是把整個 settings 攤平。攤平的後果是:未來有人加一個
 * 欄位(例如「我的伺服器位址」),它會**自動**出現在報告裡,而沒有人想過
 * 那一欄該不該出現。逐項列出的成本是「新增設定要記得加一行」,那是一個
 * 會在 code review 被看見的成本 —— 這是刻意的取捨。
 */
export function settingsSummary(settings: AppSettings): Record<string, string | number | boolean | null> {
  return {
    stt_engine: settings.stt.engine,
    stt_model: settings.stt.localModel,
    stt_language: settings.stt.language,
    // 雲端 STT 的端點:只到主機名。完整 URL 可能含路徑與專案識別。
    stt_endpoint: settings.stt.engine === 'cloud' ? endpointHost(settings.stt.cloud.baseUrl) : '(未使用)',
    // 布林而不是字串 'true'/'false':這兩個欄位名含 key(會被遮蔽規則視為敏感),
    // 而「敏感命名的欄位只准放布林或數字」是 observability.test.ts 釘住的契約 ——
    // 用字串的話契約會被自己的欄位破掉,那道閘門就等於沒有。
    stt_key_set: !!settings.stt.cloud.apiKey,
    ai_provider: settings.ai.provider,
    ai_model: settings.ai.provider === 'ollama' ? settings.ai.ollama.model : settings.ai.openaiCompatible.model,
    ai_endpoint:
      settings.ai.provider === 'ollama'
        ? endpointHost(settings.ai.ollama.baseUrl)
        : endpointHost(settings.ai.openaiCompatible.baseUrl),
    ai_key_set: settings.ai.provider === 'openai-compatible' && !!settings.ai.openaiCompatible.apiKey,
    ai_mode_enabled: settings.scenario.aiModeEnabled,
    overlay_display_mode: settings.overlay.displayMode,
    overlay_click_through: settings.overlay.clickThrough,
    overlay_capture_protected: settings.overlay.captureProtected,
    overlay_turn_yield: settings.overlay.turnYield,
    overlay_coaching: settings.overlay.coaching,
    overlay_glass: settings.overlay.glass,
    // 只記「有沒有校準過」,不記眼距數值 —— 那是生理事實,不是診斷依據。
    calibrated: settings.personal.profile ? 'true' : 'false',
    // 固定 0,之後由 buildDiagnosticsReport 蓋掉。
    // 這裡不直接讀 state:settingsSummary 是純函式,而引入 state 會讓它
    // 變成「只能在 main 裡呼叫」—— 它同時被單元測試直接餵設定使用。
    hotkey_conflict_count: 0
  }
}

/**
 * 組出完整報告。
 *
 * `hotkey_conflict_count` 是**數量**而不是名單:熱鍵衝突是回報率最高的問題之一
 * (使用者會說「我的快捷鍵沒反應」),有數量就足以讓我們知道要不要追。
 * 寫成名單沒有任何診斷價值 —— 六個欄位名稱是已知的。
 *
 * 這一個欄位是本輪修掉的一個**說謊**:呼叫端原本從來不傳 `hotkeyConflicts`,
 * 而 `?? 0` 讓它每次都寫 0 —— 也就是說「六個熱鍵全部被別的程式佔走」的使用者
 * 複製出來的報告會說「衝突數 0」。那比沒有這個欄位更糟:它讓我們**主動排除**
 * 最高頻的問題假設。一個永遠是 0 的診斷欄位,和沒有欄位一樣是空白,但多了一層
 * 「看起來量過了」的假象。
 */
export function buildDiagnosticsReport(
  settings: AppSettings,
  opts: { hotkeyConflicts?: number } = {}
): DiagnosticsReport {
  const counts = recentErrorCounts()
  const summary = settingsSummary(settings)
  summary.hotkey_conflict_count = opts.hotkeyConflicts ?? 0
  return {
    appVersion: app.getVersion(),
    platform: `${process.platform} (Electron ${process.versions.electron ?? '?'}, Node ${process.versions.node})`,
    generatedAt: new Date().toISOString(),
    settings: summary,
    errorCounts: counts
      .filter((c) => c.code.startsWith('E_'))
      .map((c) => ({ code: c.code as DiagnosticsReport['errorCounts'][number]['code'], count: c.count, lastAt: c.lastAt })),
    recentEvents: recentEvents(40).map((e) => {
      const row: DiagnosticsReport['recentEvents'][number] = { at: e.at, name: e.name }
      if (e.code) row.code = e.code as DiagnosticsReport['recentEvents'][number]['code']
      if (e.message) row.message = e.message
      // metrics 一起帶過去:沒有它的話「啟動花了幾秒」只存在於日誌檔,
      // 而使用者會貼給我們的是這份報告。
      if (e.metrics) row.metrics = e.metrics
      return row
    })
  }
}

// 轉成可貼文字的版本在 shared/observability.ts(見檔頭的匯入註解)
