import { describe, it, expect } from 'vitest'
import {
  countSpeechUnits,
  cpmForText,
  buildSessionReport,
  buildSuggestions,
  sortTranscriptSegments,
  analyzePracticeRun
} from '../session-intelligence'
import type { TranscriptSegment } from '@shared/types'

const seg = (speaker: 'me' | 'them', text: string, start: number, end: number): TranscriptSegment => ({
  speaker,
  text,
  start,
  end
})

describe('countSpeechUnits', () => {
  it('CJK 字元各計 1', () => {
    expect(countSpeechUnits('今天天氣很好')).toBe(6)
  })

  it('拉丁詞每詞計 1', () => {
    expect(countSpeechUnits('hello world foo')).toBe(3)
  })

  it('中英混稿', () => {
    expect(countSpeechUnits('我們用 React 打造架構')).toBe(7 + 1) // 7 中文字 + 1 英文詞
  })

  it('空字串回 0;標點不計', () => {
    expect(countSpeechUnits('')).toBe(0)
    expect(countSpeechUnits('好。好,好!')).toBe(3)
  })
})

describe('cpmForText', () => {
  it('60 秒說 120 個單位 = 120 字/分', () => {
    const text = Array.from({ length: 120 }, () => '字').join('')
    expect(cpmForText(text, 60)).toBe(120)
  })

  it('時長過短或空文字回 0', () => {
    expect(cpmForText('文字', 0.5)).toBe(0)
    expect(cpmForText('', 60)).toBe(0)
  })
})

describe('buildSessionReport', () => {
  it('空段落回零值報告', () => {
    const r = buildSessionReport([])
    expect(r.durationSec).toBe(0)
    expect(r.suggestions).toEqual([])
    expect(r.steadiness).toBe(100)
  })

  it('發言時間與比例', () => {
    const r = buildSessionReport([
      seg('me', '我說了一段話', 0, 30),
      seg('them', '對方回應', 30, 60),
      seg('me', '我再說', 60, 90)
    ])
    expect(r.mySec).toBe(60)
    expect(r.theirSec).toBe(30)
    expect(Math.round(r.talkRatio * 100)).toBe(67)
    expect(r.durationSec).toBe(90)
  })

  it('同說者相鄰段落合併為一輪', () => {
    const r = buildSessionReport([
      seg('me', '第一段', 0, 10),
      seg('me', '第二段', 10, 20),
      seg('them', '回應', 20, 30)
    ])
    expect(r.turnCount).toBe(2)
    expect(r.longestMyTurnSec).toBe(20)
  })

  it('同說者段落間的長停頓不計入發言時間，並列為冷場', () => {
    const r = buildSessionReport([
      seg('me', '字'.repeat(10), 0, 2),
      seg('me', '字'.repeat(10), 10, 12)
    ])
    expect(r.turnCount).toBe(2)
    expect(r.mySec).toBe(4)
    expect(r.myCpm).toBe(300)
    expect(r.longestMyTurnSec).toBe(2)
    expect(r.gapCount).toBe(1)
    expect(r.gapTotalSec).toBe(8)
  })

  it('同說者重疊片段只把交集計時一次', () => {
    const r = buildSessionReport([
      seg('me', '第一段', 0, 4),
      seg('me', '重疊段', 3, 6)
    ])
    expect(r.turnCount).toBe(1)
    expect(r.mySec).toBe(6)
    expect(r.longestMyTurnSec).toBe(6)
  })

  it('採用 VAD 發聲時長，排除片段前後的靜音', () => {
    const r = buildSessionReport([
      { ...seg('me', '我說了十秒', 0.5, 12), speechDurationSec: 10 },
      { ...seg('them', '對方說了五秒', 14, 20), speechDurationSec: 5 }
    ])
    expect(r.mySec).toBe(10)
    expect(r.theirSec).toBe(5)
    expect(r.talkRatio).toBeCloseTo(2 / 3)
    expect(r.longestMyTurnSec).toBe(10)
    expect(r.myCpm).toBe(30)
  })

  it('舊逐字稿沒有 VAD metadata 時仍以時間區間估算', () => {
    const r = buildSessionReport([seg('me', '我說了四秒', 0, 4)])
    expect(r.mySec).toBe(4)
    expect(r.myCpm).toBe(75)
  })

  it('VAD metadata 不可超過片段區間，且重疊發言不重複計時', () => {
    const r = buildSessionReport([
      { ...seg('me', '前段', 0, 4), speechDurationSec: 4 },
      { ...seg('me', '重疊段', 2, 6), speechDurationSec: 4 }
    ])
    expect(r.mySec).toBe(6)
  })

  it('冷場統計(>5 秒的間隙)', () => {
    const r = buildSessionReport([
      seg('me', '開場', 0, 10),
      seg('them', '回應', 17, 25), // gap 7s
      seg('me', '繼續', 26, 30) // gap 1s 不計
    ])
    expect(r.gapCount).toBe(1)
    expect(r.gapTotalSec).toBe(7)
  })

  it('對方問句數(中文與英文)', () => {
    const r = buildSessionReport([
      seg('them', '你的強項是什麼?', 0, 10),
      seg('me', '我的強項是後端', 10, 20),
      seg('them', 'Why did you leave your last job?', 20, 30)
    ])
    expect(r.theirQuestionCount).toBe(2)
  })

  it('steadiness:語速平穩近 100,劇烈波動下降', () => {
    const steady = buildSessionReport([
      seg('me', '字'.repeat(100), 0, 30),
      seg('them', '好', 30, 40),
      seg('me', '字'.repeat(100), 40, 70)
    ])
    const erratic = buildSessionReport([
      seg('me', '字'.repeat(150), 0, 30),
      seg('them', '好', 30, 40),
      seg('me', '字'.repeat(20), 40, 70)
    ])
    expect(steady.steadiness).toBeGreaterThanOrEqual(95)
    expect(erratic.steadiness).toBeLessThan(steady.steadiness)
  })

  it('單一輪次 steadiness 為 100', () => {
    const r = buildSessionReport([seg('me', '字'.repeat(50), 0, 20)])
    expect(r.steadiness).toBe(100)
  })

  it('只有一個音訊來源時不宣稱雙方發言比例可用', () => {
    const report = buildSessionReport([seg('me', '我的發言', 0, 10)], {
      speakerAvailability: { me: true, them: false }
    })
    expect(report.talkRatioAvailable).toBe(false)
    expect(report.talkRatio).toBe(1) // 保留原始計算值供相容性與除錯,UI 不應呈現為真實比例
  })

  it('轉錄段落依語音時間排序,同起點較短片段優先且不修改輸入', () => {
    const input = [
      seg('them', '較晚片段', 5, 8),
      seg('me', '同起點較長', 1, 4),
      seg('me', '同起點較短', 1, 2)
    ]
    const sorted = sortTranscriptSegments(input)
    expect(sorted.map((s) => s.text)).toEqual(['同起點較短', '同起點較長', '較晚片段'])
    expect(input.map((s) => s.text)).toEqual(['較晚片段', '同起點較長', '同起點較短'])
  })
})

describe('buildSuggestions 規則', () => {
  const base = buildSessionReport([seg('me', '字'.repeat(100), 0, 30)])

  it('話語佔比過高 → high', () => {
    const r = buildSessionReport([
      seg('me', '長篇大論'.repeat(40), 0, 90),
      seg('them', '嗯', 90, 105)
    ])
    const s = buildSuggestions(r)
    expect(s.some((x) => x.severity === 'high' && x.message.includes('時間'))).toBe(true)
  })

  it('不可用的雙方音源不產生發言佔比或問句比例建議', () => {
    const report = {
      ...base,
      theirSec: 30,
      talkRatio: 0.9,
      theirQuestionCount: 4,
      talkRatioAvailable: false
    }
    const suggestions = buildSuggestions(report)
    expect(suggestions.some((s) => s.message.includes('時間'))).toBe(false)
    expect(suggestions.some((s) => s.message.includes('問題'))).toBe(false)
  })

  it('語速過快 → medium', () => {
    const fast = { ...base, myCpm: 380 }
    expect(buildSuggestions(fast).some((x) => x.message.includes('偏快'))).toBe(true)
  })

  it('最多 3 條且按嚴重度排序', () => {
    const r: typeof base = {
      ...base,
      theirSec: 30,
      talkRatio: 0.85,
      longestMyTurnSec: 200,
      gapCount: 5,
      gapTotalSec: 40,
      myCpm: 360
    }
    const s = buildSuggestions(r)
    expect(s.length).toBeLessThanOrEqual(3)
    const order = { high: 0, medium: 1, low: 2 } as const
    const ranks = s.map((x) => order[x.severity])
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
  })

  it('健康會話無建議', () => {
    const r = buildSessionReport([
      seg('them', '請介紹你的專案經驗?', 0, 20),
      seg('me', '字'.repeat(80), 20, 45),
      seg('them', '不錯,技術棧怎麼選?', 45, 60),
      seg('me', '字'.repeat(70), 60, 85)
    ])
    expect(buildSuggestions(r)).toHaveLength(0)
  })
})

describe('analyzePracticeRun', () => {
  it('逐題 CPM 與平均;過短回答跳過', () => {
    const out = analyzePracticeRun([
      { answerTranscript: '字'.repeat(120), durationSec: 60, feedback: { score: 80 } },
      { answerTranscript: '太短', durationSec: 1, feedback: { score: 50 } },
      { answerTranscript: '字'.repeat(60), durationSec: 60, feedback: { score: 90 } }
    ])
    expect(out.perAnswer).toHaveLength(2)
    expect(out.perAnswer[0].cpm).toBe(120)
    expect(out.avgCpm).toBe(90) // (120 + 60) / 2
    // 分數趨勢包含所有有反饋的題目(短回答也有分)
    expect(out.scores).toEqual([80, 50, 90])
  })

  it('無有效回答回 0', () => {
    expect(analyzePracticeRun([]).avgCpm).toBe(0)
    expect(analyzePracticeRun([]).scores).toEqual([])
  })
})
