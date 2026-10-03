/**
 * practiceAnswer.test.ts — 「partial」的語意:逐字稿不完整,而不是「沒拿到反饋」。
 *
 * 這條測試釘住的是修過的缺陷:取消 AI 反饋的路徑原本把 partial 寫死成 true,
 * 於是**逐字稿完整、只是不想等評論**的答案,在畫面上被標成
 * 「逐字稿可能不完整(當時語音辨識逾時或有段落失敗)」——
 * 一則錯誤的診斷,會讓使用者去查一個沒壞的麥克風。
 *
 * 負向驗證:把 buildPracticeAnswer 的 `partial: args.partial || undefined`
 * 改回 `partial: true`,第一條測試會當場變紅。
 */
import { describe, it, expect } from 'vitest'
import { buildPracticeAnswer } from '../practiceAnswer'
import type { PracticeFeedback } from '@shared/types'

const FB: PracticeFeedback = {
  score: 80,
  content: 'x',
  structure: 'y',
  delivery: 'z',
  betterAnswer: 'w'
}

describe('buildPracticeAnswer', () => {
  it('取消反饋(無 feedback、逐字稿完整)不得帶 partial 標記', () => {
    const a = buildPracticeAnswer({
      question: 'q',
      transcript: '完整的一段回答',
      answerStart: 1000,
      answerEndedAt: 5000,
      partial: false
    })
    expect(a.partial).toBeUndefined()
    expect(a.feedback).toBeUndefined()
  })

  it('真的不完整(逾時/段落失敗)才標 partial', () => {
    const a = buildPracticeAnswer({
      question: 'q',
      transcript: '少了結尾',
      answerStart: 0,
      answerEndedAt: 1000,
      partial: true
    })
    expect(a.partial).toBe(true)
  })

  it('有反饋就掛上,沒有就不掛(「未評分」由缺席表示,不是另一個旗標)', () => {
    const withFb = buildPracticeAnswer({
      question: 'q',
      transcript: 't',
      answerStart: 0,
      answerEndedAt: 1000,
      partial: false,
      feedback: FB
    })
    expect(withFb.feedback).toEqual(FB)
    const withoutFb = buildPracticeAnswer({
      question: 'q',
      transcript: 't',
      answerStart: 0,
      answerEndedAt: 1000,
      partial: false
    })
    expect(withoutFb.feedback).toBeUndefined()
  })

  it('時長不會是負值(計時被重置時的防護)', () => {
    const a = buildPracticeAnswer({
      question: 'q',
      transcript: 't',
      answerStart: 5000,
      answerEndedAt: 1000,
      partial: false
    })
    expect(a.durationSec).toBe(0)
    expect(Number.isFinite(a.durationSec)).toBe(true)
  })

  it('逐字稿與題目原樣保留(取消反饋不能弄丟使用者講的話)', () => {
    const a = buildPracticeAnswer({
      question: '介紹你自己',
      transcript: '我負責的產品是…',
      answerStart: 0,
      answerEndedAt: 2000,
      partial: false
    })
    expect(a.question).toBe('介紹你自己')
    expect(a.answerTranscript).toBe('我負責的產品是…')
    expect(a.durationSec).toBe(2)
  })
})
