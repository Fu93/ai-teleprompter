// 統一 AI 呼叫介面：依設定路由到 Ollama 或 OpenAI 相容 API
import type { AppSettings } from '@shared/types'
import type { OllamaChatApiRequest } from '@shared/api'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * 使用者按下「取消」時 main 回的字串。
 *
 * 為什麼需要一個專屬的錯誤:呼叫端必須能分辨「AI 失敗了」(值得一個紅色 toast
 * 與一筆事件)與「使用者自己按了取消」(不該跳錯誤、也不該記成失敗)。
 * 兩者共用一個 catch 卻表現不同,是那種「使用者看到紅色錯誤框而他只是按了取消」
 * 的失敗。
 */
export const AI_CANCELLED = 'AI_CANCELLED'

export function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === AI_CANCELLED
}

/**
 * 一個可取消的 AI 呼叫。
 *
 * 回傳 handle 而不是只給 promise:取消需要 requestId,而 requestId 是在
 * 發出請求的那一刻才決定的(與 ollama.ts 的 abortControllers 共用同一個
 * 命名空間)。把它藏在 promise 裡的話,呼叫端拿到 handle 時已經太晚。
 *
 * 用法:
 *   const chat = startAiChat(settings, messages)
 *   ... 需要時 chat.cancel()
 *   const text = await chat.promise
 */
export interface AiChatHandle {
  promise: Promise<string>
  cancel: () => void
}

export function startAiChat(
  settings: AppSettings,
  messages: ChatMessage[],
  opts?: { temperature?: number }
): AiChatHandle {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return {
    promise: aiChat(settings, messages, { ...opts, requestId }),
    cancel: () => {
      // 刻意不 await:這是 fire-and-forget 的 UI 反應,
      // 而 await 會讓「按了取消」等一次 IPC 往返才回到 try/catch。
      void window.api.ollamaAbort(requestId).catch(() => undefined)
    }
  }
}

export async function aiChat(
  settings: AppSettings,
  messages: ChatMessage[],
  opts?: { temperature?: number; requestId?: string }
): Promise<string> {
  const ai = settings.ai
  const requestId = opts?.requestId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  if (ai.provider === 'ollama') {
    const req: OllamaChatApiRequest = {
      requestId,
      baseUrl: ai.ollama.baseUrl,
      model: ai.ollama.model,
      messages,
      temperature: opts?.temperature
    }
    const res = await window.api.ollamaChat(req)
    if (!res.ok) throw new Error(res.error ?? 'AI 呼叫失敗')
    if (res.text === AI_CANCELLED) throw new Error(AI_CANCELLED)
    return res.text ?? ''
  }
  const { baseUrl, apiKey, model } = ai.openaiCompatible
  if (!baseUrl || !model) throw new Error('請先在設定頁填入 OpenAI 相容 API 的 Base URL 與模型')
  const res = await window.api.openAiChat({ requestId, baseUrl, apiKey, model, messages, temperature: opts?.temperature })
  if (!res.ok) throw new Error(res.error ?? 'AI 呼叫失敗')
  // main 端在取消與逾時時都回這個字串;統一轉成可辨識的錯誤
  if (res.error === '已取消') throw new Error(AI_CANCELLED)
  return res.text ?? ''
}

/** 實際會收到請求的模型名稱(與 aiChat 的路由一致);摘要紀錄等出處標記用 */
export function resolvedModelName(settings: AppSettings): string {
  const ai = settings.ai
  return ai.provider === 'ollama' ? ai.ollama.model : ai.openaiCompatible.model
}

/** 從 LLM 輸出中取出 JSON（容忍 ```json 圍籬、前後雜文） */
export function extractJson<T>(raw: string): T {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(candidate) as T
  } catch {
    // 找第一個 { 或 [ 到最後一個 } 或 ]
    const start = candidate.search(/[{[]/)
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T
    }
    throw new Error('AI 回傳的不是有效 JSON：' + raw.slice(0, 200))
  }
}
