/**
 * providerDetection.ts — provider 判別(自 flowprompt-v3 移植)
 *
 * 規則:明確設定 > key 前綴偵測;無 key 視為本機 Ollama。
 */

export type ProviderId = 'openai' | 'anthropic' | 'groq' | 'ollama' | 'openai-compatible'

export const PROVIDER_ALIASES: Record<string, ProviderId> = {
  openai: 'openai',
  OpenAI: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  Claude: 'anthropic',
  'Anthropic Claude': 'anthropic',
  groq: 'groq',
  Groq: 'groq',
  ollama: 'ollama',
  Ollama: 'ollama',
  'Ollama (Local)': 'ollama',
  'openai-compatible': 'openai-compatible',
  'OpenAI 相容': 'openai-compatible'
}

/** 依 API key 前綴偵測 provider */
export function detectProviderFromKey(apiKey: unknown): ProviderId {
  if (!apiKey || typeof apiKey !== 'string') return 'ollama' // 無 key = 本機 Ollama
  if (apiKey.startsWith('sk-ant-')) return 'anthropic'
  if (apiKey.startsWith('gsk_')) return 'groq'
  if (apiKey.startsWith('sk-')) return 'openai'
  return 'openai-compatible' // 自訂 endpoint(新專案的第四種形態)
}

/** 明確設定優先於 key 偵測;'stub'/undefined 回退偵測 */
export function resolveProviderId(apiKey: unknown, aiProviderSetting: unknown): ProviderId {
  const explicit = PROVIDER_ALIASES[aiProviderSetting as string]
  return explicit || detectProviderFromKey(apiKey)
}

/** 使用者模型在 provider 支援清單內才採用,否則回退預設 */
export function resolveModel(
  supportedModels: readonly string[] | undefined,
  defaultModel: string,
  userModel: unknown,
  isLocal = false
): string {
  if (isLocal) return defaultModel
  if (Array.isArray(supportedModels) && typeof userModel === 'string' && supportedModels.includes(userModel)) {
    return userModel
  }
  return defaultModel
}
