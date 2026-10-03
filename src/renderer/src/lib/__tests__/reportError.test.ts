/**
 * reportError.test.ts — 統一錯誤回報的入口契約。
 *
 * 這組測試守的是三個性質,每一個都對應一個真實的失敗模式:
 *
 *  1. **認得的錯誤才有按鈕。** 對一個我們不知道成因的錯誤給「前往設定」,
 *     是給一個自信的假診斷 —— 使用者會跑去改一個不相關的設定,然後回來
 *     發現沒用,下一次就不信這份提示了。
 *  2. **UI 先於日誌。** 順序反過來的話,若事件紀錄拋出(它不會,但萬一),
 *     使用者就什麼都沒看到 —— 而「什麼都沒看到」是最難回報的症狀。
 *  3. **沒有 window.api 也不能拋。** 稽核與單元測試環境都沒有完整的
 *     preload;一個錯誤處理路徑自己拋錯,會把原本的錯誤換成一個更難懂的。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { reportError, reportCode } from '../reportError'
import { useToasts } from '../toast'

interface LoggedEvent {
  name: string
  code?: string
  message?: string
  fields?: Record<string, unknown>
  metrics?: Record<string, number>
}

function stubApi(): LoggedEvent[] {
  const events: LoggedEvent[] = []
  vi.stubGlobal('window', {
    api: {
      logEvent: (p: LoggedEvent) => {
        events.push(p)
        return Promise.resolve()
      }
    }
  })
  return events
}

describe('reportError', () => {
  beforeEach(() => {
    useToasts.setState({ items: [] })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('認得的錯誤:顯示可行動提示,並帶一顆按鈕', () => {
    const events = stubApi()
    const e = new Error('Permission denied')
    e.name = 'NotAllowedError'
    reportError('無法開啟麥克風', e, { event: 'transcribe_failed' })

    const items = useToasts.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('error')
    // 提示必須同時包含「發生了什麼」與「該去哪裡」—— 只回答一題等於沒回答
    expect(items[0].message).toContain('無法開啟麥克風')
    expect(items[0].message).toContain('麥克風')
    expect(items[0].action?.kind).toBe('goto')
    expect(events[0].code).toBe('E_MIC_PERMISSION_DENIED')
  })

  it('不認得的錯誤:有提示但**沒有按鈕**', () => {
    const events = stubApi()
    reportError('存檔失敗', new Error('Something totally unexpected happened'), {
      event: 'backup_failed'
    })
    const items = useToasts.getState().items
    expect(items[0].action).toBeUndefined()
    // 但事件仍然要記,而且代碼是 E_UNKNOWN —— 診斷報告裡「認不出來」
    // 本身就是一個有價值的訊號(它告訴我們規則表該補哪一條)
    expect(events[0].code).toBe('E_UNKNOWN')
  })

  it('連線失敗依 provider 給不同代碼與不同按鈕', () => {
    stubApi()
    reportError('AI 摘要失敗', new Error('fetch failed'), { event: 'ai_request_failed', provider: 'ollama' })
    const ollama = useToasts.getState().items[0]
    expect(ollama.action?.kind).toBe('external')

    useToasts.setState({ items: [] })
    reportError('AI 摘要失敗', new Error('fetch failed'), {
      event: 'ai_request_failed',
      provider: 'openai-compatible'
    })
    const cloud = useToasts.getState().items[0]
    // 雲端不該給「下載 Ollama」—— 那正是「自信但錯誤的診斷」
    expect(cloud.action?.label).not.toContain('Ollama')
    expect(cloud.message).not.toContain('ollama serve')
  })

  it('事件 message 帶原始錯誤,中文指引不會混進去', () => {
    const events = stubApi()
    const e = new Error('NotAllowedError boom')
    e.name = 'NotAllowedError'
    reportError('無法開啟麥克風', e, { event: 'transcribe_failed' })
    // 診斷者要對照的是使用者的描述與原始錯誤,不是我們的文案(文案會改)
    expect(events[0].message).toContain('NotAllowedError')
    expect(events[0].message).toContain('無法開啟麥克風')
    expect(events[0].message).not.toContain('隱私權與安全性')
  })

  it('silent(使用者取消):不顯示、不記事件', () => {
    const events = stubApi()
    reportError('還原已取消', new Error('canceled'), { event: 'backup_failed', silent: true })
    expect(useToasts.getState().items).toHaveLength(0)
    // 診斷報告若充滿「使用者自己取消的還原」,真正的失敗會被洗掉
    expect(events).toHaveLength(0)
  })

  it('quiet(背景重試):只記事件,不跳提示', () => {
    const events = stubApi()
    reportError('語音辨識失敗', new Error('network error'), { event: 'transcribe_failed', quiet: true })
    expect(useToasts.getState().items).toHaveLength(0)
    expect(events).toHaveLength(1)
  })

  it('沒有 window.api 時不拋 —— 錯誤處理自己不該變成錯誤', () => {
    vi.stubGlobal('window', {})
    expect(() =>
      reportError('存檔失敗', new Error('boom'), { event: 'backup_failed' })
    ).not.toThrow()
    // 提示仍然要出現在畫面上:那才是使用者唯一看得到的東西
    expect(useToasts.getState().items).toHaveLength(1)
  })
})

describe('reportCode', () => {
  beforeEach(() => {
    useToasts.setState({ items: [] })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('指定代碼:即使錯誤字串是 NotAllowedError 也不會被誤診成麥克風', () => {
    // 這是整個模組存在的主要理由:螢幕擷取被拒也是 NotAllowedError,
    // 而它要修的是螢幕擷取授權,不是麥克風權限。
    const events = stubApi()
    const e = new Error('Permission denied')
    e.name = 'NotAllowedError'
    reportCode('E_SYSTEM_AUDIO_UNAVAILABLE', e, { event: 'transcribe_failed' })
    const items = useToasts.getState().items
    expect(items[0].message).toContain('系統音訊')
    // 關鍵不是「字面不出現麥克風」—— 那句話裡提到麥克風是**正確的**
    // (「或先只用我的麥克風開始」是可行的退路)。要證明的是它沒有把他
    // 導去改**麥克風權限**那個不相關的系統設定。
    expect(items[0].message).not.toContain('權限')
    expect(items[0].message).not.toContain('隱私權與安全性')
    expect(events[0].code).toBe('E_SYSTEM_AUDIO_UNAVAILABLE')
  })
})
