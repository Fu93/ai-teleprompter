import { describe, it, expect, vi } from 'vitest'
import { PanicOrchestrator } from '../orchestrator'
import { ConversationTracker, getScene } from '../scenes'
import { PANIC_COOLDOWN_MS, PANIC_FAILURE_BACKOFF_MS } from '../orchestrator'

function makeDeps(aiImpl?: (system: string, user: string) => Promise<string>) {
  const tracker = new ConversationTracker(3)
  tracker.add('them', 'Why did you choose this approach?')
  const aiCall =
    aiImpl ?? (vi.fn(async (system: string, user: string) => `AI rescue for: ${user}`) as (s: string, u: string) => Promise<string>)
  return {
    deps: { scene: getScene('interview'), tracker, aiCall },
    tracker,
    aiCall
  }
}

describe('PanicOrchestrator.trigger', () => {
  it('成功走 AI,回傳文字與 meta', async () => {
    const { deps, aiCall } = makeDeps()
    const orch = new PanicOrchestrator(deps)
    const res = await orch.trigger(10_000)
    expect(res.ok).toBe(true)
    expect(res.source).toBe('ai')
    expect(res.text).toContain('AI rescue')
    expect(res.meta?.scene).toBe('interview')
    expect(res.meta?.followUpType).toBe('challenge')
    expect(aiCall).toHaveBeenCalledTimes(1)
  })

  it('cooldown 期內觸發被擋', async () => {
    const { deps, aiCall } = makeDeps()
    const orch = new PanicOrchestrator(deps)
    await orch.trigger(10_000)
    const second = await orch.trigger(10_000 + PANIC_COOLDOWN_MS - 100)
    expect(second.source).toBe('cooldown')
    expect(second.ok).toBe(false)
    expect(aiCall).toHaveBeenCalledTimes(1)
  })

  it('AI 失敗 → 模板 + 記錄失敗;backoff 期內直接模板', async () => {
    const failing = vi.fn(async (_system: string, _user: string): Promise<string> => {
      throw new Error('boom')
    })
    const { deps, tracker } = makeDeps()
    deps.aiCall = failing
    const orch = new PanicOrchestrator(deps)

    const first = await orch.trigger(10_000)
    expect(first.source).toBe('template')
    // tracker 有 1 筆 turn → 輪替索引 1
    expect(first.text).toBe(getScene('interview').templates[1])
    expect(first.meta?.aiError).toBe('boom')

    // backoff 期內:不呼叫 AI,直接模板
    const second = await orch.trigger(10_000 + PANIC_FAILURE_BACKOFF_MS - 100)
    expect(second.source).toBe('template')
    expect(failing).toHaveBeenCalledTimes(1)

    // backoff 過後:再試 AI
    failing.mockImplementation(async () => 'recovered answer')
    const third = await orch.trigger(10_000 + PANIC_FAILURE_BACKOFF_MS + 2000)
    expect(third.source).toBe('ai')
    expect(third.text).toBe('recovered answer')
    void tracker
  })

  it('AI 回空字串視為失敗走模板', async () => {
    const { deps } = makeDeps()
    deps.aiCall = async () => '   '
    const orch = new PanicOrchestrator(deps)
    const res = await orch.trigger(10_000)
    expect(res.source).toBe('template')
  })

  it('stats 統計 AI vs template 比率', async () => {
    const { deps } = makeDeps()
    deps.aiCall = async () => {
      throw new Error('down')
    }
    const orch = new PanicOrchestrator(deps)
    await orch.trigger(10_000) // AI 失敗 → template
    // backoff 已過 → 再試 AI → 又失敗 → template
    await orch.trigger(10_000 + PANIC_FAILURE_BACKOFF_MS + 10)
    const s = orch.stats()
    expect(s.total).toBe(2)
    expect(s.templateRate).toBe(1)
    expect(s.aiRate).toBe(0)
  })

  it('無對話時 userText 用預設句', async () => {
    const tracker = new ConversationTracker(3)
    const seen: string[] = []
    const deps = {
      scene: getScene('default'),
      tracker,
      aiCall: async (_s: string, user: string) => {
        seen.push(user)
        return 'ok'
      }
    }
    const orch = new PanicOrchestrator(deps)
    await orch.trigger(5_000)
    expect(seen[0]).toBe('Help me respond naturally.')
  })
})
