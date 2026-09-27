import { describe, expect, it } from 'vitest'
import {
  createTurnYieldState,
  evaluateTurnYield,
  isQuestion,
  recordTurnYield
} from '../turnYield'

const T0 = 1_000_000

describe('isQuestion 問句/邀答語尾偵測', () => {
  it('直接問號(中英文)→ true', () => {
    expect(isQuestion('請介紹一下你自己?')).toBe(true)
    expect(isQuestion('Tell me about yourself?')).toBe(true)
    expect(isQuestion('為什麼想離開現在的公司？ ')).toBe(true)
  })

  it('繁中語尾助詞 → true', () => {
    expect(isQuestion('你之前有帶過團隊嗎')).toBe(true)
    expect(isQuestion('可以簡單說說吧。')).toBe(true)
    expect(isQuestion('後來呢')).toBe(true)
  })

  it('英文啟動詞問句 → true', () => {
    expect(isQuestion('Do you have any questions for us?')).toBe(true)
    expect(isQuestion('Can you walk me through this project')).toBe(true)
  })

  it('繁中疑問詞句 → true', () => {
    expect(isQuestion('說說你怎麼處理團隊衝突的')).toBe(true)
    expect(isQuestion('你的優勢是什麼')).toBe(true)
  })

  it('邀答句式 → true', () => {
    expect(isQuestion('麻煩你說明一下上次專案的成果')).toBe(true)
    expect(isQuestion('請你分享一個印象最深的挑戰')).toBe(true)
  })

  it('一般敘述 → false', () => {
    expect(isQuestion('我們團隊目前有八個人,主要負責後端與平台組。')).toBe(false)
    expect(isQuestion('好的,那我們看下一題。')).toBe(false)
    expect(isQuestion('')).toBe(false)
  })

  it('非開頭的一般句(含「什麼」等詞在句中但不合模式)不含語尾助詞 → false', () => {
    // 「什麼」疑問詞模式要求句尾在疑問詞之後無句號收尾⋯⋯此句以「。」結尾且疑問詞後有完整子句
    expect(isQuestion('這就是所謂的什麼敏捷開發流程。')).toBe(false)
  })
})

describe('evaluateTurnYield 評估規則', () => {
  it('對方問句 + 無我方發言 → turn', () => {
    const s = createTurnYieldState()
    const r = evaluateTurnYield(s, '可以介紹一下你自己嗎', T0)
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('turn')
    expect(r!.question).toBe(true)
  })

  it('同一觸媒句在冷卻窗內不重複觸發', () => {
    const s = createTurnYieldState()
    const first = evaluateTurnYield(s, '你的優勢是什麼', T0)
    expect(first).not.toBeNull()
    recordTurnYield(s, first!, T0)
    expect(evaluateTurnYield(s, '你的優勢是什麼', T0 + 10_000)).toBeNull()
  })

  it('不同觸媒句不受同句冷卻影響(但受全域冷卻限制)', () => {
    const s = createTurnYieldState()
    const first = evaluateTurnYield(s, '你的優勢是什麼', T0)
    recordTurnYield(s, first!, T0)
    // 5 秒後新問句:同句冷卻不通過,但全域冷卻(15s)擋下
    expect(evaluateTurnYield(s, '為什麼想加入我們', T0 + 5_000)).toBeNull()
  })

  it('全域冷卻過後的新問句 → 再度觸發', () => {
    const s = createTurnYieldState()
    const first = evaluateTurnYield(s, '你的優勢是什麼', T0)
    recordTurnYield(s, first!, T0)
    const second = evaluateTurnYield(s, '為什麼想加入我們', T0 + 16_000)
    expect(second).not.toBeNull()
    expect(second!.kind).toBe('turn')
  })

  it('peer_silence 後 20s 的長段 → 被長冷卻窗擋下(不洗版)', () => {
    const s = createTurnYieldState()
    const first = evaluateTurnYield(
      s,
      '我們團隊目前有八個人,主要負責後端與平台組,這個職位會負責資料管線的設計與維運。',
      T0
    )
    expect(first!.kind).toBe('peer_silence')
    recordTurnYield(s, first!, T0)
    expect(
      evaluateTurnYield(
        s,
        '接下來會有兩週的規劃期,屆時會再安排一次跨部門的啟動會議與工作坊。',
        T0 + 20_000
      )
    ).toBeNull()
  })

  it('peer_silence 冷卻過後的新長段 → 再度觸發', () => {
    const s = createTurnYieldState()
    const first = evaluateTurnYield(
      s,
      '我們團隊目前有八個人,主要負責後端與平台組,這個職位會負責資料管線的設計與維運。',
      T0
    )
    recordTurnYield(s, first!, T0)
    const second = evaluateTurnYield(
      s,
      '接下來會有兩週的規劃期,屆時會再安排一次跨部門的啟動會議與工作坊。',
      T0 + 61_000
    )
    expect(second).not.toBeNull()
    expect(second!.kind).toBe('peer_silence')
  })

  it('非問句短段(< 30 字)→ null(換氣不算)', () => {
    const s = createTurnYieldState()
    expect(evaluateTurnYield(s, '嗯,好。', T0)).toBeNull()
  })

  it('非問句長段(≥ 30 字)→ peer_silence', () => {
    const s = createTurnYieldState()
    const r = evaluateTurnYield(
      s,
      '我們團隊目前有八個人,主要負責後端與平台組,這個職位會負責資料管線的設計與維運,需要跨團隊溝通。',
      T0
    )
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('peer_silence')
    expect(r!.question).toBe(false)
  })

  it('空字串 → null', () => {
    const s = createTurnYieldState()
    expect(evaluateTurnYield(s, '', T0)).toBeNull()
    expect(evaluateTurnYield(s, '   ', T0)).toBeNull()
  })

  it('peerSilenceMinChars=0 停用 peer_silence', () => {
    const s = createTurnYieldState()
    const r = evaluateTurnYield(
      s,
      '我們團隊目前有八個人,主要負責後端與平台組,這個職位會負責資料管線的設計與維運,需要跨團隊溝通。',
      T0,
      { peerSilenceMinChars: 0 }
    )
    expect(r).toBeNull()
  })
})
