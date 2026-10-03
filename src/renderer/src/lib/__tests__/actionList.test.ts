/**
 * actionList.test.ts — 可複製行動清單的組裝與練習目標推導。
 *
 * 這組測試的重點是**邊界**,不是開心路徑:
 *   - 沒有 AI 摘要(本地使用者、或 AI 失敗)時仍然要產得出東西
 *   - 十秒鐘的會議不該被編造出一個練習目標
 *   - 數字為 0 時不能出現 NaN 或 Infinity —— 那會直接被複製到使用者的
 *     待辦工具裡,而那看起來像是這個产品在發瘋
 */
import { describe, it, expect } from 'vitest'
import { buildActionList, derivePracticeTarget } from '../actionList'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { MeetingSession, SessionReport, SessionSuggestion } from '@shared/types'

function report(over: Partial<SessionReport> = {}): SessionReport {
  return {
    durationSec: 1800,
    mySec: 900,
    theirSec: 900,
    talkRatio: 0.5,
    myUnits: 3000,
    myCpm: 200,
    turnCount: 20,
    avgMyTurnSec: 45,
    longestMyTurnSec: 60,
    gapCount: 0,
    gapTotalSec: 0,
    theirQuestionCount: 4,
    steadiness: 80,
    suggestions: [],
    generatedAt: 1,
    ...over
  }
}

function session(over: Partial<MeetingSession> = {}): MeetingSession {
  return {
    id: 1,
    title: '產品會議',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_001_800_000,
    segments: [],
    ...over
  }
}

const sugg = (message: string, severity: SessionSuggestion['severity'] = 'medium'): SessionSuggestion => ({
  message,
  severity
})

describe('derivePracticeTarget', () => {
  it('沒有建議時回 null —— 不編造練習目標', () => {
    // 硬擠一句出來會讓使用者照著一個不存在的目標練習。
    expect(derivePracticeTarget(report())).toBeNull()
    expect(derivePracticeTarget(null)).toBeNull()
    expect(derivePracticeTarget(undefined)).toBeNull()
  })

  it('冷場:目標必須可被計時器驗收,並說明是從哪個數字來的', () => {
    const t = derivePracticeTarget(
      report({ suggestions: [sugg('出現 3 次冷場,共 21 秒', 'high')], gapCount: 3, gapTotalSec: 21 })
    )
    expect(t?.title).toContain('停頓')
    // 「因為」欄位是這個功能的可信度來源:它讓使用者知道目標不是憑空來的
    expect(t?.because).toContain('3')
    expect(t?.goal.length).toBeGreaterThan(6)
  })

  it('打斷:優先於其他中低嚴重度建議', () => {
    const t = derivePracticeTarget(
      report({
        suggestions: [sugg('你的發言偏短', 'low'), sugg('偵測到你搶話打斷對方', 'high')],
        longestMyTurnSec: 30
      })
    )
    expect(t?.title).toContain('對方')
  })

  it('語速過快:目標裡的數字是算出來的,而且不會是 0', () => {
    // 目標是「原來的八成」:250 * 0.8 = 200。這不是拍腦袋的常數 ——
    // 讓使用者有一個明確的目標值,才可能對照錄音驗收。
    const t = derivePracticeTarget(report({ suggestions: [sugg('語速偏快', 'high')], myCpm: 250 }))
    expect(t?.goal).toContain('200')
    expect(t?.because).toContain('250')
    // myCpm 為 0 時 0.8*0 = 0,「每分鐘 0 字」是荒謬的目標。
    // Math.max(100, …) 那個下限就是為了這件事。
    const zero = derivePracticeTarget(report({ suggestions: [sugg('語速偏快', 'high')], myCpm: 0 }))
    expect(zero?.goal).toContain('100')
  })

  it('長段發言:給可驗收的秒數目標', () => {
    const t = derivePracticeTarget(report({ longestMyTurnSec: 240, suggestions: [sugg('單口相長', 'medium')] }))
    expect(t?.because).toContain('240')
    expect(t?.goal).toContain('90')
  })

  it('講太少:給「講到一半」的目標', () => {
    const t = derivePracticeTarget(report({ talkRatio: 0.2, myUnits: 500, suggestions: [sugg('發言偏少', 'medium')] }))
    expect(t?.because).toContain('20')
  })

  it('沒有可量化的建議時,回原文並明說它是觀察不是目標', () => {
    const t = derivePracticeTarget(report({ suggestions: [sugg('眼神接觸不足', 'low')] }))
    expect(t?.goal).toBe('眼神接觸不足')
    expect(t?.because).toContain('最需要留意')
  })
})

describe('buildActionList', () => {
  it('AI 摘要與量化建議都在時:三段齊全且帶 checkbox', () => {
    const list = buildActionList(
      session({
        summary: {
          abstract: '摘要',
          keyPoints: ['重點'],
          todos: ['王小明在週五前給報價', '確認 API 上線時程'],
          followUps: ['追問報價含不含稅'],
          generatedAt: 1,
          model: 'qwen2.5:7b'
        },
        report: report({ suggestions: [sugg('冷場 2 次', 'medium')], gapCount: 2, gapTotalSec: 12 })
      })
    )
    expect(list.aiMissing).toBe(false)
    expect(list.todos).toHaveLength(2)
    expect(list.followUps).toHaveLength(1)
    expect(list.target).not.toBeNull()
    const t = list.text
    expect(t).toContain('# 產品會議 — 行動清單')
    expect(t).toContain('- [ ] 王小明在週五前給報價')
    expect(t).toContain('## 需要追問或確認')
    expect(t).toContain('## 下一次練習')
    expect(t).toContain('## 這場的觀察')
  })

  it('沒有 AI 摘要(本地使用者)仍然產得出清單,且明說原因', () => {
    // 要求「先按摘要才能複製」會讓沒有雲端 AI 的使用者完全拿不到這一段。
    const list = buildActionList(session({ report: report({ longestMyTurnSec: 200, suggestions: [sugg('單口相長', 'medium')] }) }))
    expect(list.aiMissing).toBe(true)
    expect(list.target).not.toBeNull()
    expect(list.text).toContain('這場沒有產生待辦')
    // 不能是空字串或只有標題 —— 那看起來像功能壞了
    expect(list.text.length).toBeGreaterThan(60)
  })

  it('完全沒有報告也沒有摘要:仍給一個可複製的骨架', () => {
    const list = buildActionList(session())
    expect(list.target).toBeNull()
    expect(list.aiMissing).toBe(true)
    expect(list.text).toContain('## 待辦事項')
    expect(list.text).toContain('（這場沒有產生待辦')
  })

  it('不產生 NaN / Infinity —— 那會被直接複製進使用者的待辦工具', () => {
    const list = buildActionList(
      session({
        report: report({
          myCpm: 0,
          talkRatio: 0,
          myUnits: 0,
          turnCount: 0,
          avgMyTurnSec: 0,
          longestMyTurnSec: 0,
          gapCount: 0,
          gapTotalSec: 0,
          suggestions: [sugg('語速偏快', 'high'), sugg('發言偏少', 'medium')]
        })
      })
    )
    expect(list.text).not.toContain('NaN')
    expect(list.text).not.toContain('Infinity')
    expect(list.text).not.toContain('undefined')
  })

  it('結尾聲明它不含什麼 —— 複製出去的文字會離開這個 App', () => {
    const list = buildActionList(session())
    expect(list.text).toContain('不含')
  })
})
