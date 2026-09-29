/**
 * describeError.ts — 把技術錯誤翻成使用者看得懂的 actionable 指引。
 *
 * 為什麼需要這層:
 *   使用者撞到最常見的第一個牆是「麥克風權限被拒」,而 getUserMedia 丟出來的是
 *   Chromium 的英文 NotAllowedError。全專案原本有 8 處直接
 *   `toast.error(err.message)`,等於把 "Permission denied" 直接丟給中文介面,
 *   4 秒後消失,使用者既不知道發生什麼事,也不知道要去哪裡改。
 *
 *   同一個專案裡 AI 那條路徑卻寫得很好(「請先在設定頁填入 Base URL 與模型」),
 *   所以問題從來不是能力不足,而是**沒有共用層**:各頁各自決定要不要翻譯,
 *   結果好壞參半、同一個錯誤在不同頁面說法不一致。
 *
 * 設計原則:只翻譯「我們真的知道該怎麼處理」的情況,其餘一律回退到原始訊息。
 *   寧可顯示英文原文(至少是真實的),也不要給一個自信但錯誤的診斷。
 *   呼應 Record 停止時那個反例:把「辨識失敗」說成「沒有偵測到語音」,
 *   會讓使用者跑去查麥克風硬體,浪費的是他的時間。
 */

/** 取得錯誤的可比對文字:Error 用 name+message,字串直接用本身。 */
function textOf(err: unknown): string {
  if (err instanceof Error) return `${err.name} ${err.message}`
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * 規則表。順序有意義:先比對具體的 HTTP/網路錯誤,最後才是泛用的名稱比對,
 * 避免「連線失敗」被後面的規則蓋掉。
 *
 * 每條規則的訊息都必須回答使用者視角的兩個問題:
 *   1. 到底發生了什麼(用他的語言,不是 Chromium 的)
 *   2. 我接下來該去哪裡改
 * 只回答第一個的訊息等於沒回答 —— 這正是原本 toast.error(err.message) 的問題。
 */
const RULES: Array<{ test: RegExp; message: string }> = [
  {
    // 麥克風/攝影機權限被拒 —— 全新使用者最常撞到的第一個牆
    test: /NotAllowedError|Permission denied|permission.*denied|denied.*permission/i,
    message:
      '麥克風或攝影機權限被拒絕。請到「設定 → 隱私權與安全性 → 麥克風」允許這個 App,再重新錄音。'
  },
  {
    test: /NotFoundError|Requested device not found|找不到.*裝置|找不到.*麥克風/i,
    message: '找不到可用的麥克風。請確認麥克風已接上並在「錄音轉錄」頁勾選「我的麥克風」。'
  },
  {
    test: /NotReadableError|Could not start audio source|device.*(busy|in use)|裝置.*(忙碌|被占用)/i,
    message: '麥克風正被其他程式占用。請關閉其他使用麥克風的程式(例如視訊會議、錄音軟體)後再試。'
  },
  {
    // 雲端 STT / AI 的金鑰問題
    test: /\b401\b|\b403\b|invalid[_ -]?api[_ -]?key|incorrect api key|unauthorized|authentication/i,
    message: 'API 金鑰無效或過期。請到「設定」頁重新填寫 API Key 後再試。'
  },
  {
    // Ollama 沒開 —— 本地 AI 最常見的失敗
    test: /ECONNREFUSED|fetch failed|連線.*(失敗|被拒|拒絕)|無法連線/i,
    message: '無法連線到 Ollama。請確認已安裝並啟動(終端機執行 ollama serve,或直接開啟 Ollama 應用程式)。'
  },
  {
    // 本地模型沒下載 —— 第一次使用 Whisper/Ollama 都會撞到
    test: /model.*not found|404.*model|尚未下載|模型未下載|not found.*model/i,
    message: '找不到對應的本地模型。請先下載模型(或執行 ollama pull qwen2.5:7b)後再試。'
  },
  {
    test: /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|NetworkError|network.*error|網路/i,
    message: '網路連線失敗。請確認網路可用後再試。'
  }
]

/**
 * 把任意錯誤轉成給使用者看的訊息。
 * 認得的錯誤回傳可行動的中文指引;不認得的回退到原始字串 ——
 * 寧可顯示真實的英文原文,也不要給一個自信但錯誤的診斷。
 */
export function describeError(err: unknown): string {
  const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : textOf(err)
  const text = textOf(err)
  for (const r of RULES) {
    if (r.test.test(text)) return r.message
  }
  return raw || '發生未預期的錯誤'
}

/** 是否為「使用者可以自己修」的錯誤(用於決定要不要顯示詳細原文) */
export function isActionable(err: unknown): boolean {
  const text = textOf(err)
  return RULES.some((r) => r.test.test(text))
}
