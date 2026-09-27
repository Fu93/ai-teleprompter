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
