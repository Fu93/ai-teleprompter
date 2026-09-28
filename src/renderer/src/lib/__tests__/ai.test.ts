import { describe, it, expect } from 'vitest'
import { resolvedModelName } from '../ai'
import { DEFAULT_SETTINGS } from '@shared/types'

/** 回歸:會後摘要曾寫死 settings.ai.ollama.model——provider 是 openai-compatible 時,
 *  摘要實際由相容 API 產生,紀錄的卻是 ollama 欄位(多半空字串),出處無從排查。 */
describe('resolvedModelName(摘要出處標記)', () => {
  it('ollama provider 回 ollama 模型欄位', () => {
    const s = structuredClone(DEFAULT_SETTINGS)
    s.ai.provider = 'ollama'
    s.ai.ollama.model = 'qwen2.5:7b'
    expect(resolvedModelName(s)).toBe('qwen2.5:7b')
  })

  it('openai-compatible provider 回相容 API 模型欄位(而非 ollama 的)', () => {
    const s = structuredClone(DEFAULT_SETTINGS)
    s.ai.provider = 'openai-compatible'
    s.ai.openaiCompatible.model = 'gpt-4o-mini'
    s.ai.ollama.model = 'qwen2.5:7b'
    expect(resolvedModelName(s)).toBe('gpt-4o-mini')
  })
})
