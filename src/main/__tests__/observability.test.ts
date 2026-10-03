/**
 * observability.test.ts — 診斷報告與事件紀錄的**遮蔽**保證。
 *
 * 這組測試存在的理由不是「測試覆蓋率」,而是:
 *   診斷報告的唯一傳遞方式是使用者複製貼到公開 issue 上。也就是說它的內容
 *   預設會**離開這台電腦**。一份「不會洩漏」的宣稱如果沒有測試,等於沒有宣稱。
 *
 * 設計上刻意測「會洩漏的方向」而不是「有遮蔽」:每一條斷言都先造出一份
 * 含敏感內容的 settings,再確認輸出裡找不到那些值。用反向斷言(找得到某個值)
 * 才是真的證明;只斷言「有遮蔽字串」會在遮蔽機制壞掉時仍然全綠 —— 那正是
 * 這個專案記載過最多次的失敗模式(抓不到東西卻長得像防線的斷言)。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * `buildDiagnosticsReport` 會讀 `app.getVersion()`,而這個檔案原本不需要
 * electron(只測純函式)。加上最小 stub:只給它會讀的那一個,
 * 而不是匯入整個 electron —— 測試不該因為產品端多了一個 API 就壞掉。
 */
vi.mock('electron', () => ({
  app: { getVersion: () => '0.2.0-test', getPath: () => '/tmp' }
}))
import {
  endpointHost,
  formatDiagnosticsReport,
  isSensitiveField,
  redactEventFields,
  REDACTED
} from '@shared/observability'
import { settingsSummary, buildDiagnosticsReport } from '../diagnostics'
import { __resetEventState, recentEvents, recordEvent } from '../events'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { AppSettings } from '@shared/types'

/** 一份刻意充滿敏感內容的設定:端點帶 token、帶「secret」字樣的路徑。 */
const dirty: AppSettings = {
  ...DEFAULT_SETTINGS,
  stt: {
    ...DEFAULT_SETTINGS.stt,
    engine: 'cloud',
    cloud: {
      baseUrl: 'https://api.example.com/v1/sk-secret-token-abc123',
      apiKey: 'sk-super-secret-key-value',
      model: 'whisper-large-v3'
    }
  },
  ai: {
    ...DEFAULT_SETTINGS.ai,
    provider: 'openai-compatible',
    openaiCompatible: {
      baseUrl: 'https://ai.example.com/v1/tenant-9999?key=leaked',
      apiKey: 'sk-another-secret',
      model: 'gpt-4o-mini'
    }
  },
  personal: {
    profile: {
      calibratedAt: 1,
      ipdMm: 63,
      viewingDistanceCm: 60,
      hfovDeg: 60,
      charsPerMin: 240,
      sampleSeconds: 30,
      sampleChars: 120,
      derivedFontSize: 30,
      derivedSpeed: 60
    }
  }
}

describe('isSensitiveField', () => {
  it('常見的敏感命名一律命中', () => {
    // 窮舉而不是抽樣:漏掉一個新的欄位名與漏掉一個新的欄位形狀相比,
    // 後者無從發現(所以敏感判斷選了可窮舉的那一邊)。
    for (const k of [
      'apiKey',
      'API_KEY',
      'stt_api_key',
      'token',
      'authToken',
      'secret',
      'password',
      'transcript',
      'content',
      'scriptContent',
      'rawText',
      'prompt',
      'authorization'
    ]) {
      expect(isSensitiveField(k), `${k} 應該被視為敏感`).toBe(true)
    }
  })

  it('診斷用的旗標不得被誤判成敏感(否則報告全被遮掉)', () => {
    for (const k of ['engine', 'provider', 'model', 'stt_language', 'overrides', 'turn_yield']) {
      expect(isSensitiveField(k), `${k} 不該被視為敏感`).toBe(false)
    }
  })
})

describe('redactEventFields', () => {
  it('敏感欄位換成遮蔽字串,非敏感欄位原樣保留', () => {
    const out = redactEventFields({ engine: 'cloud', apiKey: 'sk-x', model: 'whisper' })
    expect(out?.engine).toBe('cloud')
    expect(out?.model).toBe('whisper')
    expect(out?.apiKey).toBe(REDACTED)
  })

  it('遮蔽是**真的**:輸出裡不得殘留原始值的任何一部分', () => {
    // 反向斷言。只檢查「有遮蔽字串」會在遮蔽機制整組壞掉時仍然全綠。
    const secret = 'sk-super-secret-key-value'
    const out = redactEventFields({ apiKey: secret, transcript: secret, content: `prefix${secret}` })
    const text = JSON.stringify(out)
    expect(text).not.toContain('super-secret')
    expect(text).not.toContain(secret.slice(0, 6))
  })

  /**
   * 契約的邊界:**只**看欄位名,不看值。
   *
   * 這不是缺陷而是刻意的取捨(理由見 SENSITIVE_KEY_PATTERNS 的註解):
   * 名稱有限、可窮舉、可測試;值的形狀不可。所以「有人把逐字稿放進一個叫
   * `note` 的欄位」是這個設計擋不住的情況。
   *
   * 把這條寫成測試(而不是刪掉)的原因:它讓未來有人要把遮蔽改成「看值」時,
   * 必須先看到這條並且想清楚代價 —— 否則很容易以為「已經有遮蔽了」而放心地
   * 放更多東西進去。
   */
  it('契約邊界:欄位名不敏感時,值原樣保留(不假裝有值層遮蔽)', () => {
    const out = redactEventFields({ note: 'sk-looks-like-a-key' })
    expect(out?.note).toBe('sk-looks-like-a-key')
  })

  it('undefined 進、undefined 出(不製造空物件)', () => {
    expect(redactEventFields(undefined)).toBeUndefined()
  })
})

describe('endpointHost', () => {
  it('只留主機名:路徑與 query 裡的識別碼不進報告', () => {
    // 這是真實發生過的形狀:OpenAI 相容端點的 query 或 path 裡可能帶著
    // 專案 ID 或 token。診斷只需要知道「連到哪個服務」。
    expect(endpointHost('https://api.example.com/v1/sk-secret-token-abc123')).toBe('api.example.com')
    expect(endpointHost('https://ai.example.com/v1/tenant-9999?key=leaked')).toBe('ai.example.com')
  })

  it('本機位址保留埠號:Ollama 還是雲端是最常被問的第一個問題', () => {
    expect(endpointHost('http://localhost:11434')).toBe('localhost:11434')
  })

  it('不是合法 URL 時不丟整段,也不丟空字串', () => {
    expect(endpointHost('htt')).toBe('htt')
    expect(endpointHost('x'.repeat(100))).toHaveLength(41) // 40 + 省略號
    expect(endpointHost(undefined)).toBeNull()
    expect(endpointHost(null)).toBeNull()
  })
})

describe('settingsSummary', () => {
  beforeEach(() => {
    __resetEventState()
  })

  it('報告裡不出現任何金鑰值', () => {
    const s = settingsSummary(dirty)
    const text = JSON.stringify(s)
    expect(text).not.toContain('sk-super-secret-key-value')
    expect(text).not.toContain('sk-another-secret')
  })

  it('報告裡的端點只有主機名,不帶路徑與 query', () => {
    const s = settingsSummary(dirty)
    expect(s.stt_endpoint).toBe('api.example.com')
    expect(s.ai_endpoint).toBe('ai.example.com')
    expect(JSON.stringify(s)).not.toContain('tenant-9999')
    expect(JSON.stringify(s)).not.toContain('sk-secret-token')
  })

  it('金鑰只以「有沒有填」的形式出現,不是值', () => {
    const s = settingsSummary(dirty)
    // 布林,不是 'true' 字串:這兩個欄位名含 key,契約要求它們只放布林或數字
    expect(s.stt_key_set).toBe(true)
    expect(s.ai_key_set).toBe(true)
  })

  it('個人校準只記「有沒有校準過」,不記眼距等生理事實', () => {
    const s = settingsSummary(dirty)
    expect(s.calibrated).toBe('true')
    // IPD(瞳距)是生理事實,不是診斷依據;報告會離開這台電腦。
    expect(JSON.stringify(s)).not.toContain('ipd')
    expect(JSON.stringify(s)).not.toContain('63')
  })

  it('名稱落在敏感命名裡的欄位,值只能是布林或數字', () => {
    // 這是這個測試存在的理由:寫出來時有三個欄位名含 key(`stt_key_set`、
    // `ai_key_set`、`hotkey_conflict_count`),而它們正是**刻意**要暴露的:
    // 「他填了金鑰沒有」是診斷問題一的第一個問題。
    //
    // 所以規則不是「欄位名敏感就整個遮掉」(那會把這三個欄位變成無用的空字串,
    // 而報告裡看起來與「沒填金鑰」一樣 —— 那是比洩漏更難察覺的說謊),
    // 而是:這些欄位**只准放布林或數字**。
    // 這條斷言就是那道閘門:未來有人把 `stt_key_set` 改成放前 6 碼的 key,
    // 或新增一個 `apiKeyPreview` 之類的欄位,這裡會立刻變紅。
    const s = settingsSummary(dirty)
    for (const [k, v] of Object.entries(s)) {
      if (!isSensitiveField(k)) continue
      // 只准布林與數字(計數)。字串是最危險的形狀 —— 金鑰、路徑、
      // 逐字稿全都是字串;而一個數字或 true/false 不可能是秘密。
      expect(['boolean', 'number'], `${k} 只准放布林或數字`).toContain(typeof v)
    }
  })

  it('「有沒有填金鑰」本身必須看得出來(遮蔽不能把診斷訊息一併消掉)', () => {
    // 上一條的反面。遮蔽做到連布林都藏起來的話,報告會在「他沒填金鑰」
    // 與「我們不知道他填了沒有」之間無法分辨 —— 那正是最貴的一種空白。
    const filled = settingsSummary(dirty)
    expect(filled.stt_key_set).toBe(true)
    expect(settingsSummary(DEFAULT_SETTINGS).ai_key_set).toBe(false)
  })

  it('未使用雲端時端點欄位寫「未使用」,不留空字串', () => {
    const s = settingsSummary(DEFAULT_SETTINGS)
    expect(s.stt_endpoint).toBe('(未使用)')
    expect(s.stt_key_set).toBe(false)
  })
})

/**
 * `hotkey_conflict_count` 本輪修掉的一個**說謊**。
 *
 * 症狀:診斷報告裡的「熱鍵衝突數」永遠是 0 —— 因為呼叫端從來不傳
 * `hotkeyConflicts`,而預設值是 0。也就是說「六個熱鍵全部被別的程式佔走」
 * 的使用者複製出來的報告,會寫著「衝突數 0」。
 *
 * 這比沒有這個欄位更糟:它讓我們**主動排除**回報率最高的問題假設。
 * 一個永遠是 0 的診斷欄位,和沒有欄位一樣是空白,但多了一層「看起來量過了」的假象。
 */
describe('hotkey_conflict_count 不得永遠是 0', () => {
  beforeEach(() => {
    __resetEventState()
  })

  it('把實際衝突數帶進報告', () => {
    const r = buildDiagnosticsReport(DEFAULT_SETTINGS, { hotkeyConflicts: 6 })
    expect(r.settings.hotkey_conflict_count).toBe(6)
  })

  it('沒衝突時才是 0', () => {
    const r = buildDiagnosticsReport(DEFAULT_SETTINGS, { hotkeyConflicts: 0 })
    expect(r.settings.hotkey_conflict_count).toBe(0)
  })

  it('衝突數會出現在報告文字裡(不然等於沒量)', () => {
    const text = formatDiagnosticsReport(buildDiagnosticsReport(DEFAULT_SETTINGS, { hotkeyConflicts: 3 }))
    expect(text).toContain('hotkey_conflict_count = 3')
  })
})

/**
 * metrics 這條路徑**不會**經過 redactEventFields。
 *
 * 為什麼要有這組測試:`metrics` 在型別上是 `Record<string, number>`,而型別在
 * 執行期不存在。若沒有人在存入前過濾,未來有人寫 `metrics: { note: 使用者輸入 }`
 * 時,它會繞過遮蔽直接進到診斷報告 —— 而報告預設會離開這台電腦。
 *
 * 與 fields 的差別是契約性的:fields 的敏感欄位會被換成遮蔽字串(所以仍然看得到),
 * 而 metrics 的契約是「**只准是數字**」,不是數字的就丟掉。
 */
describe('recordEvent 的 metrics 管道', () => {
  beforeEach(() => {
    __resetEventState()
  })

  const last = () => recentEvents()[0]

  it('數字會進記憶體(診斷報告是從記憶體組的)', () => {
    // 這一條釘住本輪修掉的真缺陷:metrics 原本只寫進日誌檔案。症狀是
    // 「啟動花了 4.2 秒」有寫進去,而使用者複製診斷報告時看不到 ——
    // 而那份報告才是他會貼給我們的東西。
    recordEvent({ name: 'startup_main_ready', metrics: { ms: 4212, conflicts: 0 } })
    expect(last().metrics).toEqual({ ms: 4212, conflicts: 0 })
  })

  it('非數字的值被丟棄,不是原樣留下', () => {
    // 反向斷斷言。metrics 不經過 redactEventFields,所以這裡的守門人
    // 就是「只留有限數字」這一條。
    recordEvent({
      name: 'ai_request_failed',
      metrics: { ms: 120, secret: 'sk-do-not-log-me' as unknown as number, nan: Number.NaN }
    })
    const text = JSON.stringify(last().metrics)
    expect(text).not.toContain('do-not-log-me')
    expect(last().metrics?.ms).toBe(120)
    expect(Object.keys(last().metrics ?? {})).toEqual(['ms'])
  })

  it('NaN 與 Infinity 都不算指標(它們會讓 JSON 變成 null,報告裡出現 "ms": null)', () => {
    recordEvent({ name: 'coaching_fired', metrics: { a: Number.NaN, b: Number.POSITIVE_INFINITY } })
    expect(last().metrics).toBeUndefined()
  })

  it('metrics 會出現在報告文字裡(否則記了等於沒記)', () => {
    const text = formatDiagnosticsReport({
      appVersion: '0.2.0',
      platform: 'test',
      generatedAt: '2026-10-02T00:00:00.000Z',
      settings: {},
      errorCounts: [],
      recentEvents: [
        { at: '2026-10-02T00:00:00.000Z', name: 'startup_main_ready', metrics: { ms: 4212 } }
      ]
    })
    expect(text).toContain('startup_main_ready')
    expect(text).toContain('ms=4212')
  })

  it('沒有 metrics 的事件不會多印一堆空白或 undefined', () => {
    const text = formatDiagnosticsReport({
      appVersion: '0.2.0',
      platform: 'test',
      generatedAt: '2026-10-02T00:00:00.000Z',
      settings: {},
      errorCounts: [],
      recentEvents: [{ at: '2026-10-02T00:00:00.000Z', name: 'diagnostics_report_requested' }]
    })
    expect(text).toContain('diagnostics_report_requested')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('null')
  })
})
