import { describe, it, expect } from 'vitest'
import { detectProviderFromKey, resolveProviderId, resolveModel } from '../providerDetection'
import { PROVIDERS, resolveEndpoint, buildRequestBody, extractChatText } from '../providerRegistry'

describe('detectProviderFromKey(v3 案例移植)', () => {
  it('無 key → ollama', () => {
    expect(detectProviderFromKey(null)).toBe('ollama')
    expect(detectProviderFromKey('')).toBe('ollama')
    expect(detectProviderFromKey(undefined)).toBe('ollama')
  })

  it('key 前綴偵測', () => {
    expect(detectProviderFromKey('sk-ant-api03-xxx')).toBe('anthropic')
    expect(detectProviderFromKey('gsk_ABC123')).toBe('groq')
    expect(detectProviderFromKey('sk-proj-XYZ')).toBe('openai')
  })

  it('未知前綴 → openai-compatible(自訂 endpoint)', () => {
    expect(detectProviderFromKey('cf_custom_key')).toBe('openai-compatible')
  })
})

describe('resolveProviderId(設定覆蓋 key 偵測)', () => {
  it("明確設定 'Ollama' 壓過 sk- key", () => {
    expect(resolveProviderId('sk-xxx', 'Ollama')).toBe('ollama')
  })

  it("明確設定 'Groq' 壓過 sk-ant- key", () => {
    expect(resolveProviderId('sk-ant-xxx', 'Groq')).toBe('groq')
  })

  it("undefined / 'stub' 回退 key 偵測", () => {
    expect(resolveProviderId('gsk_x', undefined)).toBe('groq')
    expect(resolveProviderId('gsk_x', 'stub')).toBe('groq')
    expect(resolveProviderId(undefined, 'stub')).toBe('ollama')
  })
})

describe('resolveModel', () => {
  const cfg = PROVIDERS['openai']

  it('支援清單內採用', () => {
    expect(resolveModel(cfg.models, cfg.defaultModel, 'gpt-4o')).toBe('gpt-4o')
  })

  it('無效 / undefined 回退預設', () => {
    expect(resolveModel(cfg.models, cfg.defaultModel, 'gpt-99')).toBe(cfg.defaultModel)
    expect(resolveModel(cfg.models, cfg.defaultModel, undefined)).toBe(cfg.defaultModel)
  })

  it('防跨 provider 污染', () => {
    expect(resolveModel(PROVIDERS['groq'].models, PROVIDERS['groq'].defaultModel, 'gpt-4o')).toBe(
      PROVIDERS['groq'].defaultModel
    )
  })
})

describe('resolveEndpoint', () => {
  it('ollama 經 SSRF 正規化:非法回 null', () => {
    expect(resolveEndpoint(PROVIDERS['ollama'], 'http://localhost:11434')).toBe('http://localhost:11434/api/chat')
    expect(resolveEndpoint(PROVIDERS['ollama'], 'http://169.254.169.254')).toBeNull()
  })

  it('openai-compatible:補 /chat/completions', () => {
    expect(resolveEndpoint(PROVIDERS['openai-compatible'], 'https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/chat/completions'
    )
    expect(resolveEndpoint(PROVIDERS['openai-compatible'], 'https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1/chat/completions'
    )
    expect(resolveEndpoint(PROVIDERS['openai-compatible'], '')).toBeNull()
    expect(resolveEndpoint(PROVIDERS['openai-compatible'], 'ftp://x')).toBeNull()
  })

  /**
   * 這組是**為了擋住一個真的發生過的漏接**才加的。
   *
   * 背景:outboundEndpoint.ts 建立了統一的出站政策(擋 link-local metadata、
   * 未指定位址、內嵌憑證…),ipc.ts 的 OpenAiChat / CloudTranscribe 兩條路徑
   * 都接上了。但 resolveEndpoint 的 openai-compatible 分支原本只做
   * `/^https?:\/\//` 前綴檢查,**沒有**呼叫那份政策 —— 而 chatCompletion
   * (Panic 救援 Alt+P 與 AiChatCompletion 走的就是它)正是經過這裡。
   * 結果是:填錯網址後按救援鍵,應用程式會帶著
   * `Authorization: Bearer <你的金鑰>` 打到 169.254.169.254。
   *
   * 這裡測純函式(回 null),「擋在 fetch 之前」那一半在
   * src/main/__tests__/outboundFetchGuard.test.ts —— 兩邊缺一不可:
   * 只測這裡,整套換掉 fetch 仍會綠;只測那邊,這裡可以整段刪掉仍會綠。
   */
  it('openai-compatible:雲端 metadata / link-local 一律回 null', () => {
    const cfg = PROVIDERS['openai-compatible']
    expect(resolveEndpoint(cfg, 'http://169.254.169.254')).toBeNull()
    expect(resolveEndpoint(cfg, 'http://169.254.169.254/v1')).toBeNull()
    expect(resolveEndpoint(cfg, 'https://169.254.1.1/latest/meta-data')).toBeNull()
  })

  it('openai-compatible:URL 正規化後的 IPv4-mapped metadata 一樣被擋', () => {
    // new URL() 會把 [::ffff:169.254.169.254] 變成 hex 形狀 [::ffff:a9fe:a9fe],
    // 只比點號形狀的防護在這裡是空的(見 ipHost.ts 的說明)。
    expect(resolveEndpoint(PROVIDERS['openai-compatible'], 'http://[::ffff:169.254.169.254]/v1')).toBeNull()
    expect(resolveEndpoint(PROVIDERS['openai-compatible'], 'http://[::ffff:a9fe:a9fe]:8000/v1')).toBeNull()
  })

  it('openai-compatible:未指定位址 / multicast / reserved 被擋', () => {
    const cfg = PROVIDERS['openai-compatible']
    expect(resolveEndpoint(cfg, 'http://0.0.0.0:8000/v1')).toBeNull()
    expect(resolveEndpoint(cfg, 'http://[::]:8000/v1')).toBeNull()
    expect(resolveEndpoint(cfg, 'http://239.1.2.3:8000/v1')).toBeNull()
    expect(resolveEndpoint(cfg, 'http://255.255.255.255:8000/v1')).toBeNull()
  })

  it('openai-compatible:內嵌憑證被擋(會被 Authorization 蓋掉,留著只是誤導)', () => {
    expect(resolveEndpoint(PROVIDERS['openai-compatible'], 'http://user:pass@api.example.com/v1')).toBeNull()
  })

  it('openai-compatible:query / fragment 被丟掉,不讓路徑掉進 query', () => {
    // 沒有這條的話,使用者填 https://host/v1?x=1 會得到
    // https://host/v1?x=1/chat/completions —— 一個沒有原因的 404。
    expect(resolveEndpoint(PROVIDERS['openai-compatible'], 'https://api.example.com/v1?x=1')).toBe(
      'https://api.example.com/v1/chat/completions'
    )
  })

  /**
   * 政策是黑名單,所以**正常使用方式必須證明沒有被擋掉**。
   * 這一條比上面那些擋截測試更重要:區網自架 vLLM / LM Studio / Tailscale
   * (CGNAT 100.64/10、Docker ULA fc00::/7)被誤擋,就是把產品弄壞。
   */
  it('openai-compatible:區網自架 / loopback / CGNAT 照常可用', () => {
    const cfg = PROVIDERS['openai-compatible']
    expect(resolveEndpoint(cfg, 'http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1/chat/completions')
    expect(resolveEndpoint(cfg, 'http://192.168.1.20:8000/v1')).toBe('http://192.168.1.20:8000/v1/chat/completions')
    expect(resolveEndpoint(cfg, 'http://100.101.102.103:11434/v1')).toBe(
      'http://100.101.102.103:11434/v1/chat/completions'
    )
    expect(resolveEndpoint(cfg, 'http://[fd00::1]:8000/v1')).toBe('http://[fd00::1]:8000/v1/chat/completions')
  })

  it('openai-compatible:已經帶 /chat/completions 的網址不被重複拼接', () => {
    expect(resolveEndpoint(PROVIDERS['openai-compatible'], 'https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions'
    )
  })

  it('具名 provider 用註冊表 endpoint', () => {
    expect(resolveEndpoint(PROVIDERS['groq'], undefined)).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(resolveEndpoint(PROVIDERS['anthropic'], undefined)).toBe('https://api.anthropic.com/v1/messages')
  })
})

describe('buildRequestBody / extractChatText', () => {
  const messages = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hi' }
  ]

  it('anthropic:system 抽到頂層,取 content[0].text', () => {
    const cfg = PROVIDERS['anthropic']
    const body = buildRequestBody(cfg, { model: 'claude-x', messages, maxTokens: 120 }) as Record<string, unknown>
    expect(body['system']).toBe('sys')
    expect(body['max_tokens']).toBe(120)
    expect(Array.isArray(body['messages'])).toBe(true)
    expect(
      extractChatText(cfg, { content: [{ text: 'ok' }] })
    ).toBe('ok')
  })

  it('ollama:options.num_predict,取 message.content', () => {
    const cfg = PROVIDERS['ollama']
    const body = buildRequestBody(cfg, { model: 'qwen2.5:7b', messages, maxTokens: 100 }) as Record<string, unknown>
    const options = body['options'] as Record<string, unknown>
    expect(options['num_predict']).toBe(100)
    expect(body['stream']).toBe(false)
    expect(extractChatText(cfg, { message: { content: 'local-ok' } })).toBe('local-ok')
  })

  it('openai:jsonMode 只在支援時加 response_format', () => {
    const cfg = PROVIDERS['openai']
    const withJson = buildRequestBody(cfg, { model: 'gpt-4o-mini', messages, jsonMode: true }) as Record<string, unknown>
    expect(withJson['response_format']).toEqual({ type: 'json_object' })
    const groqBody = buildRequestBody(PROVIDERS['anthropic'], {
      model: 'claude-x',
      messages,
      jsonMode: true
    }) as Record<string, unknown>
    expect(groqBody['response_format']).toBeUndefined()
    expect(extractChatText(cfg, { choices: [{ message: { content: 'cloud-ok' } }] })).toBe('cloud-ok')
  })
})
