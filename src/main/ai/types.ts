// AI 層共用型別(main / renderer 共用;不依賴 electron)

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionRequest {
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  jsonMode?: boolean
  timeoutMs?: number
}

export interface ChatCompletionResult {
  ok: boolean
  text?: string
  error?: string
  meta?: {
    provider: string
    model: string
    latencyMs: number
  }
}
