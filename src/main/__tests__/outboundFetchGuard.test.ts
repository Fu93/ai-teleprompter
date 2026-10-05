import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { AppSettings } from '@shared/types'

// ollama.ts → debug.ts 會在模組層求值時讀 electron 的 app,單元測試環境裡是
// undefined。mock 掉 electron 而不是 debug:這樣被測的是 ollama.ts 真正的
// 邏輯(含 E2E_ENV 判斷),而不是一個為了測試而改過的版本。
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '' } }))

const { ollamaListModels, ollamaVersion, ollamaChat } = await import('../ollama')
// aiProvider 與 ollama 讀同一份 electron mock(只需要 app.getPath)。
const { chatCompletion } = await import('../ai/aiProvider')

/**
 * 這裡測的是**呼叫端行為**,不是純函式。
 *
 * 為什麼不在 outboundEndpoint.test.ts 就結束:那邊已經證明政策本身是對的,
 * 但「ollama.ts 有沒有真的呼叫它」是另一個問題 —— 而且是可以整段刪掉而
 * 測試仍然全綠的那種。ipc.ts 的兩個 handler 是 Electron 註冊的閉包,單元測試
 * 觸不到,所以這三個 ollama 函式是唯一能用 fake fetch 驗證「被擋的位址
 * 連一次網路請求都不會發生」的接縫。
 */
describe('ollama 出站端點在 fetch 之前就被擋', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ollamaListModels:metadata 位址被擋,而且沒有送出請求', async () => {
    await expect(ollamaListModels('http://169.254.169.254')).rejects.toThrow(/metadata|保留網段/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 這個是本專案真的踩過的洞:`new URL()` 會把 [::ffff:169.254.169.254]
  // 正規化成 hex 形狀 [::ffff:a9fe:a9fe],只比點號形狀的防護在這裡是空的。
  it('ollamaListModels:URL 正規化後的 IPv4-mapped metadata 一樣被擋', async () => {
    await expect(ollamaListModels('http://[::ffff:169.254.169.254]:11434')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ollamaListModels:非 http(s) 協定被擋', async () => {
    await expect(ollamaListModels('file:///etc/passwd')).rejects.toThrow(/http/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * 「網址不能用」不能被偽裝成「沒裝 Ollama」。
   *
   * ollamaVersion 的回傳值決定 preflight 的 installed 欄位,而 null 在那裡
   * 讀成「沒裝」—— 使用者會去下載一個他其實有、只是網址填錯的程式。
   */
  it('ollamaVersion:被擋的位址要往外擲,而不是回 null', async () => {
    await expect(ollamaVersion('http://169.254.169.254')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ollamaChat:被擋的位址在送出前就結束', async () => {
    await expect(
      ollamaChat(
        { requestId: 'r1', baseUrl: 'http://169.254.169.254', model: 'm', messages: [] },
        DEFAULT_SETTINGS
      )
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('loopback 位址照常送出(不能為了安全擋掉本機 Ollama)', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    await expect(ollamaListModels('http://127.0.0.1:11434')).resolves.toEqual(['qwen2.5:7b'])
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.anything())
  })

  it('區網自架(私網)照常送出', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    await expect(ollamaListModels('http://192.168.1.20:11434/')).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.20:11434/api/tags', expect.anything())
  })
})

/**
 * chatCompletion 的出站防護 —— 與上面那組對稱,但**測的是金鑰會不會外送**。
 *
 * 為什麼需要獨立一組:resolveEndpoint 純函式的測試在
 * ai/__tests__/providerDetection.test.ts。那邊證明「被判定為 null」,但證明不了
 * 「null 之後沒有別人把原網址撿起來再送一次」。而這正是 chatCompletion 路徑的
 * 真實風險:Panic 救援與 AiChatCompletion 都經過 resolveProvider → resolveEndpoint
 * → fetch,一旦某天有人加了 fallback(「endpoint 無效就用預設」),純函式測試會
 * 全綠而金鑰照樣外送。
 *
 * 所以這裡斷言的是**最底層的可觀察事實**:被擋的位址一個 fetch 都不該發生。
 */
describe('chatCompletion 在 fetch 之前就被擋,而且不帶著金鑰出去', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  /** 一個指向被擋位址的 openai-compatible 設定(含金鑰 —— 那才是風險所在) */
  function settingsPointingAt(baseUrl: string): AppSettings {
    const s = structuredClone(DEFAULT_SETTINGS) as AppSettings
    s.ai.provider = 'openai-compatible'
    s.ai.openaiCompatible.baseUrl = baseUrl
    s.ai.openaiCompatible.model = 'test-model'
    s.ai.openaiCompatible.apiKey = 'sk-test-SECRET-KEY-DO-NOT-LEAK'
    return s
  }

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('metadata 位址被擋,而且沒有送出請求', async () => {
    const result = await chatCompletion(settingsPointingAt('http://169.254.169.254/v1'), [
      { role: 'user', content: 'hi' }
    ])
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('IPv4-mapped metadata 一樣被擋', async () => {
    const result = await chatCompletion(settingsPointingAt('http://[::ffff:169.254.169.254]/v1'), [
      { role: 'user', content: 'hi' }
    ])
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('未指定位址(0.0.0.0 = 本機所有介面卡)被擋', async () => {
    const result = await chatCompletion(settingsPointingAt('http://0.0.0.0:8000/v1'), [
      { role: 'user', content: 'hi' }
    ])
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * 錯誤訊息要能回答「我該改什麼」,而不是一句泛用的「AI 未設定」。
   * 使用者看到「AI 未設定」時會去檢查 provider 與金鑰欄位,而問題其實在網址。
   */
  it('被擋時的訊息說得出是網址的問題', async () => {
    const result = await chatCompletion(settingsPointingAt('http://169.254.169.254/v1'), [
      { role: 'user', content: 'hi' }
    ])
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/metadata|保留網段/)
  })

  /** 政策是黑名單:區網自架必須照常通,否則就是把產品弄壞。 */
  it('區網自架照常送出(黑名單不能太寬)', async () => {
    const result = await chatCompletion(settingsPointingAt('http://192.168.1.20:8000/v1'), [
      { role: 'user', content: 'hi' }
    ])
    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.20:8000/v1/chat/completions', expect.anything())
  })
})
