import { describe, it, expect } from 'vitest'
import {
  SCENE_PRESETS,
  getScene,
  classifyFollowUp,
  ConversationTracker,
  buildPanicSystemPrompt,
  pickFallbackTemplate
} from '../scenes'

describe('SCENE_PRESETS', () => {
  it('8 個內建場景齊全且欄位完整', () => {
    const keys = SCENE_PRESETS.map((s) => s.key)
    expect(keys).toEqual(
      expect.arrayContaining(['interview', 'sales', 'investor', 'podcast', 'demo', 'support', 'defense', 'default'])
    )
    for (const s of SCENE_PRESETS) {
      expect(s.templates.length).toBeGreaterThanOrEqual(3)
      expect(s.lengthBudget).toBeGreaterThan(0)
      expect(['low', 'medium', 'high']).toContain(s.riskLevel)
    }
  })

  it('getScene 未知 key 回退 default', () => {
    expect(getScene('nonexistent').key).toBe('default')
    expect(getScene('sales').label).toBe('Sales Call')
  })
})

describe('classifyFollowUp(中英關鍵詞)', () => {
  it('空字串 → unknown', () => {
    expect(classifyFollowUp('')).toBe('unknown')
    expect(classifyFollowUp('   ')).toBe('unknown')
  })

  it('挑戰類(挑戰)', () => {
    expect(classifyFollowUp('Why should we believe that?')).toBe('challenge')
    expect(classifyFollowUp('你確定嗎?我有點懷疑')).toBe('challenge')
  })

  it('異議類(異議);與挑戰並列時挑戰先到先得(v3 逐字行為)', () => {
    expect(classifyFollowUp('Why is this expensive?')).toBe('challenge') // why + expensive 並列
    expect(classifyFollowUp('太貴了 成本太高')).toBe('objection')
  })

  it('澄清類(澄清)', () => {
    expect(classifyFollowUp('What do you mean by that?')).toBe('clarification')
  })

  it('追問類(追問)', () => {
    expect(classifyFollowUp('And what happened next?')).toBe('followup')
  })

  it('技術類(技術)', () => {
    expect(classifyFollowUp('How does the architecture handle failures?')).toBe('technical')
  })
})

describe('ConversationTracker', () => {
  it('超出 maxTurns 時保留最後 N 筆', () => {
    const t = new ConversationTracker(3)
    t.add('them', 'q1')
    t.add('self', 'a1')
    t.add('them', 'q2')
    t.add('self', 'a2')
    t.add('them', 'q3')
    expect(t.turns).toHaveLength(3)
    expect(t.turns.map((x) => x.text)).toEqual(['q2', 'a2', 'q3'])
  })

  it('lastQuestion 找最後一個非 self 的 turn', () => {
    const t = new ConversationTracker(3)
    t.add('them', 'why did revenue drop?')
    t.add('self', 'let me explain')
    expect(t.lastQuestion()?.text).toBe('why did revenue drop?')
    expect(t.lastSelfTurn()?.text).toBe('let me explain')
  })

  it('非 self turn 自動分類 followUpType', () => {
    const t = new ConversationTracker(3)
    t.add('them', '太貴了 成本太高')
    expect(t.lastQuestion()?.followUpType).toBe('objection')
  })

  it('toPromptContext 組 role: text;空回 null', () => {
    const t = new ConversationTracker(3)
    expect(t.toPromptContext()).toBeNull()
    t.add('them', 'hello')
    t.add('self', 'hi there')
    expect(t.toPromptContext()).toBe('them: hello\nself: hi there')
  })
})

describe('buildPanicSystemPrompt', () => {
  it('包含 tone/label/risk/budget 與禁則', () => {
    const tracker = new ConversationTracker(3)
    const scene = getScene('interview')
    const prompt = buildPanicSystemPrompt(scene, tracker)
    expect(prompt).toContain('professional on-stage rescue assistant')
    expect(prompt).toContain('Scene: Job Interview.')
    expect(prompt).toContain('Risk level: medium')
    expect(prompt).toContain('<= 80 tokens')
    expect(prompt).toContain('Never apologize')
  })

  it('有對話時附 follow-up type 與上下文', () => {
    const tracker = new ConversationTracker(3)
    tracker.add('them', 'Why should we pick you?')
    const prompt = buildPanicSystemPrompt(getScene('interview'), tracker)
    expect(prompt).toContain('Detected follow-up type: challenge')
    expect(prompt).toContain('them: Why should we pick you?')
  })
})

describe('pickFallbackTemplate', () => {
  it('依 turn 數輪替模板;空回固定句', () => {
    const tracker = new ConversationTracker(3)
    const scene = getScene('default')
    const first = pickFallbackTemplate(scene, tracker)
    expect(first).toBe(scene.templates[0])
    tracker.add('them', 'q')
    expect(pickFallbackTemplate(scene, tracker)).toBe(scene.templates[1])
  })
})
