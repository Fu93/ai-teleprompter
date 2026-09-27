/**
 * scenes.ts — 場景引擎(自 flowprompt-v3 context-engine 完整移植,純函數)
 *
 * 8 種內建場景 preset + 追問分類 + 對話追蹤 + panic system prompt 組裝。
 */

export type ToneType = 'calm' | 'professional' | 'empathic' | 'energetic' | 'defensive'
export type RiskLevel = 'low' | 'medium' | 'high'
export type TempoType = 'slow' | 'medium' | 'fast'

export interface ScenePreset {
  key: string
  label: string
  tone: ToneType
  tempo: TempoType
  lengthBudget: number
  riskLevel: RiskLevel
  turns: number
  templates: string[]
  source?: string
}

export const SCENE_PRESETS: ScenePreset[] = [
  {
    key: 'interview',
    label: 'Job Interview',
    tone: 'professional',
    tempo: 'medium',
    lengthBudget: 80,
    riskLevel: 'medium',
    turns: 3,
    templates: [
      'That is a great question. Let me think through it carefully.',
      'I would approach that by first clarifying the requirements, then proposing a solution.',
      'In my experience, the key trade-off here is between speed and quality.'
    ]
  },
  {
    key: 'sales',
    label: 'Sales Call',
    tone: 'energetic',
    tempo: 'fast',
    lengthBudget: 60,
    riskLevel: 'low',
    turns: 4,
    templates: [
      'I completely understand your concern. Many of our customers felt the same way initially.',
      'Could I share a quick example of how a similar company solved this?',
      'What would success look like for you in the next quarter?'
    ]
  },
  {
    key: 'investor',
    label: 'Investor Q&A',
    tone: 'professional',
    tempo: 'medium',
    lengthBudget: 100,
    riskLevel: 'high',
    turns: 5,
    templates: [
      'The core thesis is that the market is shifting from X to Y, and we are positioned at the inflection point.',
      'Let me put a number on that — we are projecting ARR growth of 3x by year two.',
      'To be candid, the biggest risk is competition, which is why we have a 6-month moat in distribution.'
    ]
  },
  {
    key: 'podcast',
    label: 'Podcast / Webinar',
    tone: 'calm',
    tempo: 'slow',
    lengthBudget: 120,
    riskLevel: 'low',
    turns: 2,
    templates: [
      'That is a perspective I had not considered before — tell me more.',
      'I think the interesting tension here is between efficiency and authenticity.',
      'Building on what you said earlier, I would add that...'
    ]
  },
  {
    key: 'demo',
    label: 'Live Demo',
    tone: 'energetic',
    tempo: 'fast',
    lengthBudget: 50,
    riskLevel: 'low',
    turns: 2,
    templates: [
      'Watch what happens when I click this — the response time drops to under 200ms.',
      'Notice how the system automatically routes this to the right handler.',
      'This is the part I am most excited about — let me show you.'
    ]
  },
  {
    key: 'support',
    label: 'Customer Support',
    tone: 'empathic',
    tempo: 'medium',
    lengthBudget: 70,
    riskLevel: 'medium',
    turns: 4,
    templates: [
      'I hear how frustrating that must be. Let me walk you through what we can do.',
      'Thank you for flagging this. I will make sure it gets to the right team.',
      'To make sure I solve the right problem, could you share what you were trying to do?'
    ]
  },
  {
    key: 'defense',
    label: 'Academic Defense',
    tone: 'professional',
    tempo: 'slow',
    lengthBudget: 150,
    riskLevel: 'high',
    turns: 6,
    templates: [
      'Thank you for the question. My work addresses a gap in the literature by...',
      'The reviewer raises a valid point. I addressed this in Chapter 3 by...',
      'I would like to respectfully note that the contribution is on the methodological side, not the empirical side.'
    ]
  },
  {
    key: 'default',
    label: 'Generic',
    tone: 'calm',
    tempo: 'medium',
    lengthBudget: 80,
    riskLevel: 'medium',
    turns: 3,
    templates: [
      'Let me take a moment to think through that.',
      'That is an important point. Here is how I see it.',
      'I would like to come back to that with a more concrete answer.'
    ]
  }
]

export function getScene(key: string): ScenePreset {
  return SCENE_PRESETS.find((s) => s.key === key) ?? SCENE_PRESETS[SCENE_PRESETS.length - 1]
}

// ── 追問分類 ──

export type FollowUpType =
  | 'clarification'
  | 'challenge'
  | 'objection'
  | 'followup'
  | 'topic_shift'
  | 'personal'
  | 'technical'
  | 'unknown'

const FOLLOWUP_KEYWORDS: Record<Exclude<FollowUpType, 'unknown'>, string[]> = {
  challenge: ['why', 'prove', 'evidence', 'really', 'sure about', 'doubt', 'but actually', '為什麼', '證明', '真的嗎', '確定', '懷疑'],
  objection: ['expensive', 'cost', 'too much', 'why not', 'competitor', 'alternative', '太貴', '成本', '競爭', '替代'],
  clarification: ['what do you mean', 'could you explain', 'in other words', 'specifically', '什麼意思', '解釋', '具體', '詳細'],
  followup: ['and', 'also', 'additionally', 'further', 'next', '還有', '另外', '接著', '然後'],
  topic_shift: ['by the way', 'moving on', "let's talk about", 'switching to', 'next question', '換個話題', '另外一個話題', '話說回來', '下一題'],
  personal: ['you', 'your experience', 'your background', 'yourself', '你', '你的', '你自己'],
  technical: ['how does', 'architecture', 'api', 'algorithm', 'implementation', '怎麼', '架構', '實作', '算法']
}

export function classifyFollowUp(text: string): FollowUpType {
  const lower = text.toLowerCase().trim()
  if (!lower) return 'unknown'

  let best: FollowUpType = 'unknown'
  let bestScore = 0
  for (const [type, keywords] of Object.entries(FOLLOWUP_KEYWORDS) as Array<[Exclude<FollowUpType, 'unknown'>, string[]]>) {
    let score = 0
    for (const w of keywords) {
      if (lower.includes(w)) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = type
    }
  }
  return best
}

// ── 對話追蹤 ──

export interface ConversationTurn {
  role: 'self' | string
  text: string
  followUpType: FollowUpType
  t: number
}

export class ConversationTracker {
  readonly maxTurns: number
  turns: ConversationTurn[] = []

  constructor(maxTurns = 3) {
    this.maxTurns = maxTurns
  }

  add(role: string, text: string): ConversationTurn {
    const turn: ConversationTurn = {
      role,
      text,
      followUpType: role === 'self' ? 'unknown' : classifyFollowUp(text),
      t: Date.now()
    }
    this.turns.push(turn)
    if (this.turns.length > this.maxTurns) {
      this.turns = this.turns.slice(-this.maxTurns)
    }
    return turn
  }

  lastQuestion(): ConversationTurn | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role !== 'self') return this.turns[i]
    }
    return null
  }

  lastSelfTurn(): ConversationTurn | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === 'self') return this.turns[i]
    }
    return null
  }

  toPromptContext(): string | null {
    if (this.turns.length === 0) return null
    return this.turns.map((t) => `${t.role}: ${t.text}`).join('\n')
  }

  reset(): void {
    this.turns = []
  }
}

// ── Panic system prompt(v3 buildPanicSystemPrompt 逐行對應)──

export function buildPanicSystemPrompt(scene: ScenePreset, tracker: ConversationTracker): string {
  const lines: string[] = [
    `You are a ${scene.tone} on-stage rescue assistant.`,
    `Scene: ${scene.label}.`,
    `Risk level: ${scene.riskLevel}. Keep claims defensible.`,
    `Response budget: <= ${scene.lengthBudget} tokens. Speakable, not text-on-screen.`
  ]

  const lastQ = tracker.lastQuestion()
  if (lastQ) {
    lines.push(`Detected follow-up type: ${lastQ.followUpType}.`)
  }

  const ctx = tracker.toPromptContext()
  if (ctx) {
    lines.push(`[Recent conversation:\n${ctx}]`)
  }

  lines.push(
    'Reply with a single short sentence (or two) the user can read aloud immediately.',
    'Never apologize. Never reference being an AI. Never echo the question verbatim.'
  )

  return lines.join('\n')
}

/** 由場景模板輪替取 fallback(turn 數決定) */
export function pickFallbackTemplate(scene: ScenePreset, tracker: ConversationTracker): string {
  if (!scene.templates || scene.templates.length === 0) {
    return 'Let me think about that for a moment.'
  }
  const idx = tracker.turns.length % scene.templates.length
  return scene.templates[idx]
}
