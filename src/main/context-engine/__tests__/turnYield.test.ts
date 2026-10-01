import { describe, expect, it, vi } from 'vitest'
import {
  createTurnYieldGate,
  createTurnYieldState,
  evaluateTurnYield,
  isQuestion,
  recordTurnYield,
  TURN_YIELD_DEBOUNCE_MS
} from '../turnYield'
import type { TurnYieldPayload } from '@shared/types'

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

/**
 * gate 層:「評估 → 防抖 → 送出 → 送出成功才記冷卻」。
 *
 * 這組測試釘住的是一個**真的產品缺陷**,不是測試自己的方便:
 * 舊版在排防抖時就記冷卻,所以浮層視窗那一刻不在(已收掉/被銷毀)或 renderer
 * 還沒訂閱(`useTurnYield` 在 turnYield=false 時不註冊 listener)時,
 * 訊號送不出去但 25 秒冷卻已記 —— 使用者那句問話就永遠不會再提示。
 *
 * 假時鐘/假 timer 全部注入,所以這裡不靠真實等待,也沒有任何 flaky 空間。
 */
describe('createTurnYieldGate 防抖 → 送達才記冷卻', () => {
  /** 注入假時鐘與手動觸發的 timer:回傳 { push, fire, delivered, gate, advance } */
  function makeGate(deliver: (p: TurnYieldPayload) => boolean = () => true) {
    let clock = T0
    let armed: (() => void) | null = null
    const delivered: TurnYieldPayload[] = []
    const gate = createTurnYieldGate({
      deliver: (p) => {
        const ok = deliver(p)
        if (ok) delivered.push(p)
        return ok
      },
      now: () => clock,
      setTimer: (fn) => {
        armed = fn
      },
      clearTimer: () => {
        armed = null
      }
    })
    return {
      gate,
      delivered,
      advance: (ms: number) => {
        clock += ms
      },
      /** 推進時間並觸發防抖到期 */
      fire: (ms = TURN_YIELD_DEBOUNCE_MS) => {
        clock += ms
        const fn = armed
        armed = null
        fn?.()
      },
      isArmed: () => armed !== null
    }
  }

  it('問句 → 防抖後送出一次,冷卻從「送出時刻」起算', () => {
    const h = makeGate()
    h.gate.push('可以請你介紹一下你自己嗎')
    expect(h.delivered).toHaveLength(0) // 防抖還沒到
    h.advance(500)
    h.fire() // t = T0 + 500 + 1200
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].kind).toBe('turn')
    expect(h.gate.state.lastFiredAt).toBe(T0 + 500 + TURN_YIELD_DEBOUNCE_MS)
  })

  it('**送達失敗 → 不消耗冷卻 → 同一句話立刻能再觸發**(本次修的行為)', () => {
    let overlayUp = false // 浮層視窗還沒回來
    const h = makeGate(() => overlayUp)
    h.gate.push('可以請你介紹一下你自己嗎')
    h.fire()
    expect(h.delivered).toHaveLength(0)
    // 關鍵:冷卻必須是乾淨的。舊行為在這裡會是 25 秒同句冷卻已經記下,
    // 於是這句話接下來 25 秒內永遠不會再提示 —— 使用者看到的就是「提示憑空消失」。
    expect(h.gate.state.lastFiredAt).toBe(0)

    // 視窗回來了,同一句話重推 → 這次送達
    overlayUp = true
    h.gate.push('可以請你介紹一下你自己嗎')
    h.fire()
    expect(h.delivered).toHaveLength(1)
    expect(h.gate.state.lastFiredAt).not.toBe(0)
  })

  it('送達成功 → 冷卻照舊生效(同句 25s 擋、換句 15s 擋)', () => {
    const h = makeGate()
    h.gate.push('你的優勢是什麼')
    h.fire()
    expect(h.delivered).toHaveLength(1)
    expect(h.gate.state.lastFiredText).toBe('你的優勢是什麼')

    // 同句、冷卻窗內 → 不觸發
    h.gate.push('你的優勢是什麼')
    expect(h.isArmed()).toBe(false)
    expect(h.delivered).toHaveLength(1)

    // 換句但仍在全域冷卻(15s)內 → 不觸發
    h.advance(5_000)
    h.gate.push('為什麼想加入我們')
    expect(h.isArmed()).toBe(false)
    expect(h.delivered).toHaveLength(1)

    // 冷卻過後的換句 → 再度觸發
    h.advance(12_000) // 距上次送出已 17s > 15s
    h.gate.push('為什麼想加入我們')
    h.fire()
    expect(h.delivered).toHaveLength(2)
  })

  it('防抖窗內連推多句 → 只送出一發(防抖合併行為與舊版等價)', () => {
    const h = makeGate()
    h.gate.push('那我們請你說明一下背景')
    h.advance(400)
    h.gate.push('這個專案主要是資料管線')
    h.advance(400)
    h.gate.push('可以請你說明一下這個案例嗎')
    h.fire()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].kind).toBe('turn')
  })

  it('pending 是 turn 時,後到的長段不降級成 peer_silence', () => {
    const h = makeGate()
    h.gate.push('可以請你說明一下這個案例嗎')
    h.advance(300)
    h.gate.push(
      '我們團隊目前有八個人,主要負責後端與平台組,這個職位會負責資料管線的設計與維運。'
    )
    h.fire()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].kind).toBe('turn')
  })

  it('cancel() → 未到期的提示不會送出,也不記冷卻', () => {
    const h = makeGate()
    h.gate.push('可以請你說明一下這個案例嗎')
    h.gate.cancel() // 我方開口
    h.fire()
    expect(h.delivered).toHaveLength(0)
    expect(h.gate.state.lastFiredAt).toBe(0)
  })

  it('reset() → 清 pending 與冷卻(會話邊界)', () => {
    const h = makeGate()
    h.gate.push('你的優勢是什麼')
    h.fire()
    expect(h.gate.state.lastFiredAt).not.toBe(0)
    h.gate.reset()
    expect(h.gate.state.lastFiredAt).toBe(0)
    expect(h.gate.state.lastFiredText).toBe('')
  })

  it('push() 回傳 undefined(純函式層沒有副作用契約),排防抖即完成', () => {
    const h = makeGate()
    expect(h.gate.push('你的優勢是什麼')).toBeUndefined()
    expect(h.isArmed()).toBe(true)
  })
})
