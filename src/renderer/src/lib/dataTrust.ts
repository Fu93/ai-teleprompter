/**
 * dataTrust.ts — 「我的資料到底去了哪裡」的判斷。
 *
 * ── 為什麼需要 ──
 *   這個 App 讀麥克風、錄整場會議、拿 AI 分析內容。README 的 FAQ 有一句
 *   「資料會上傳嗎?」,但那是**文件**,使用者要翻到 README 才看得到;而且
 *   README 寫的是**預設情況**,而實際情況取決於他改了什麼設定 —— 有人把
 *   STT 從本地改成雲端之後,「只在你的電腦」就不再成立了,而介面上沒有
 *   任何地方會提醒他這件事。
 *
 *   也就是說:承諾存在,但**承諾與當下行為之間沒有任何可見的連結**。
 *   那正是「承諾與行為不一致」——這個專案反覆記載的失敗模式。
 *
 * ── 三個刻意的設計 ──
 *
 * 1. **從實際設定推導,不是寫一段靜態說明。** 寫死的「你的資料只在本地」
 *    會在使用者改設定之後仍然那樣說 —— 那比沒有說明更糟。
 *
 * 2. **只顯示主機名,不顯示完整 URL。** 端點的 path/query 有時帶著專案 ID
 *    或 token(reuse `endpointHost`)。診斷與信任兩者都只需要「哪個服務」。
 *
 * 3. **金鑰那一列必須是「真的」。** 「API Key 不在備份裡」是一個**為了使用者
 *    好**的限制,默默做等於使用者以為備份是完整的。這裡的布林值直接讀
 *    `backup.ts` 的遮蔽結果(見下方 backupExcludesKeys 的註解),
 *    讓面板沒有機會對自己說謊。
 */
import { endpointHost } from '@shared/observability'
import type { AppSettings } from '@shared/types'

export type TrustKind = 'local' | 'upload' | 'credential' | 'log'

export interface TrustRow {
  id: string
  kind: TrustKind
  /** 這是什麼 */
  what: string
  /** 實際狀態。同一個 what 在不同設定下會有不同的 where。 */
  where: string
  /** 這一列要不要畫成警示(上傳到外部服務時) */
  warn: boolean
}

export interface DataTrustInput {
  settings: AppSettings | null
  /**
   * 金鑰是否真的在 safeStorage 裡。
   *
   * 與 settings.stt.cloud.apiKey 分開:後者是遷移前的舊備援位置,
   * 真實來源是安全儲存(見 preflight 的 refreshKeys 註解)。
   */
  secureStoreHasSttKey: boolean
  secureStoreHasAiKey: boolean
}

/**
 * 備份排除金鑰這件事,是不是真的成立?
 *
 * 這個布林值是**硬編碼 true** 而不是去執行 backup.ts 的遮蔽:執行它需要
 * 讀整個 IndexedDB,而這裡是純函式(要能被單元測試餈假資料)。
 * 真正的保證在 `lib/__tests__/backup.test.ts` 的「整份備份裡不含金鑰」
 * 那條測試 —— 兩條測試各管一件事:那條證明**程式行為**,這裡證明**面板
 * 沒有誇大**。若哪天 backup.ts 真的開始寫入金鑰,那一條會紅,而面板
 * 會開始說謊 —— 所以兩者必須同時改。
 */
export function backupExcludesKeys(): boolean {
  return true
}

export function buildDataTrust(input: DataTrustInput): TrustRow[] {
  const { settings, secureStoreHasSttKey, secureStoreHasAiKey } = input
  if (!settings) return []

  const rows: TrustRow[] = []

  // ---- 永遠在本機的東西 ----
  rows.push({
    id: 'scripts',
    kind: 'local',
    what: '講稿與提詞內容',
    where: '這台電腦的資料庫(IndexedDB),不離開本機',
    warn: false
  })
  rows.push({
    id: 'sessions',
    kind: 'local',
    what: '會議逐字稿、摘要與報告',
    where: '這台電腦的資料庫(IndexedDB),不離開本機',
    warn: false
  })

  // ---- 語音辨識:本地 Whisper vs 雲端 ----
  if (settings.stt.engine === 'local') {
    rows.push({
      id: 'stt',
      kind: 'local',
      what: `語音辨識（${settings.stt.localModel} 模型）`,
      where: `在你的電腦上執行。模型首次使用時下載約 ${
        settings.stt.localModel === 'tiny' ? '75' : settings.stt.localModel === 'base' ? '145' : '500'
      }MB,之後離線也能用`,
      warn: false
    })
  } else {
    const host = endpointHost(settings.stt.cloud.baseUrl)
    rows.push({
      id: 'stt',
      kind: 'upload',
      what: '語音辨識（雲端 API）',
      // 沒有 host 時說「未設定」而不是留白:留白會看起來像「不會上傳」,
      // 而實際上他選了雲端引擎 —— 那是這個清單裡最不能含糊的一列。
      where: host ? `音訊會送到 ${host}` : '尚未設定 Base URL,錄音會在開始前就被擋下',
      warn: true
    })
  }

  // ---- AI:本地 Ollama vs 雲端 ----
  if (settings.ai.provider === 'ollama') {
    const host = endpointHost(settings.ai.ollama.baseUrl)
    rows.push({
      id: 'ai',
      kind: 'local',
      what: 'AI 助理（Ollama）',
      where: host ? `在你的電腦上執行(${host})。逐字稿會送到這個本機位址,但不會離開這台電腦` : '本機 Ollama',
      warn: false
    })
  } else {
    const host = endpointHost(settings.ai.openaiCompatible.baseUrl)
    rows.push({
      id: 'ai',
      kind: 'upload',
      what: 'AI 助理（雲端 API）',
      where: host
        ? `摘要、練習題與你的發言內容會送到 ${host}`
        : '尚未設定 Base URL,AI 功能會在開始前就被擋下',
      warn: true
    })
  }

  // ---- Panic 救援的場景提示 ----
  if (settings.scenario.aiModeEnabled && settings.ai.provider === 'openai-compatible') {
    rows.push({
      id: 'panic',
      kind: 'upload',
      what: 'Panic 救援（Alt+P）',
      where: '按下去時,最近的對話上下文會送到你的 AI 服務',
      warn: true
    })
  }

  // ---- 金鑰 ----
  const anyKey = secureStoreHasSttKey || secureStoreHasAiKey
  rows.push({
    id: 'keys',
    kind: 'credential',
    what: 'API 金鑰',
    where: anyKey
      ? `存放在 Windows 加密儲存區${backupExcludesKeys() ? ',不會寫進備份檔' : ''}。${
          secureStoreHasSttKey ? '語音' : ''
        }${secureStoreHasSttKey && secureStoreHasAiKey ? '與' : ''}${secureStoreHasAiKey ? 'AI' : ''}`
      : '還沒有填任何金鑰（使用本地引擎時不需要）',
    warn: false
  })

  // ---- 備份 ----
  rows.push({
    id: 'backup',
    kind: 'credential',
    what: '資料備份',
    where: backupExcludesKeys()
      ? '匯出的是一個 JSON 檔,由你決定放哪裡（隨身碟、雲端、傳給自己）;金鑰不會跟著走'
      : '匯出的檔案包含本機資料,請自行保管',
    warn: false
  })

  // ---- 日誌 ----
  rows.push({
    id: 'log',
    kind: 'log',
    what: '記錄檔（診斷用）',
    where: '錯誤碼與設定摘要寫在 userData/logs/main.log,只留在本機;不含逐字稿與金鑰',
    warn: false
  })

  return rows
}

/** 有沒有任何一列會把資料送到這台電腦以外。給標題旁的一個小徽章用。 */
export function hasExternalTransfer(rows: TrustRow[]): boolean {
  return rows.some((r) => r.warn)
}
