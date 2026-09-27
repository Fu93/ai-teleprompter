import { describe, expect, it } from 'vitest'
import {
  checkDeadAir,
  checkInterrupt,
  countFillers,
  createCoachingState,
  onMeSegment,
  onThemSegment,
  speechUnits,
  DEFAULT_CPM
} from '../coachingRules'

const T0 = 1_000_000

function opts(over: Partial<Parameters<typeof onMeSegment>[3]> = {}): Parameters<typeof onMeSegment>[3] {
  return { baselineCpm: DEFAULT_CPM, ...over }
}

describe('speechUnits 語音單位', () => {
  it('CJK 字元各 1', () => {
    expect(speechUnits('你好世界')).toBe(4)
  })
  it('拉丁詞各 1', () => {
    expect(speechUnits('hello world')).toBe(2)
  })
  it('混排正確', () => {
    expect(speechUnits('用 React 開發了三年')).toBe(7) // 6 CJK + 1 latin word
  })
})

describe('countFillers 填充詞', () => {
  it('繁中口語填充詞', () => {
    expect(countFillers('嗯...這個...就是說...')).toBe(3)
  })
  it('英文填充詞(不分大小寫)', () => {
    expect(countFillers('Um, this is, uh, you know, like, important')).toBe(4)
  })
  it('無填充詞', () => {
    expect(countFillers('我們的做法有三個重點,第一是成本。')).toBe(0)
  })
})

describe('onMeSegment 語速過快(fast)', () => {
  const FAST_TEXT = '這是一段很有節奏的連續說話內容大概三十個字左右的長度範例' // 28 units
  it('連續快速段:超基準 1.3× → fast(fast 比 monologue 先觸發)', () => {
    const s = createCoachingState()
    let fired: ReturnType<typeof onMeSegment> = null
    // 每段 28 units、間隔 1.2s(連續)→ 第 4 段起 cpm 就遠超基準
    for (let i = 1; i <= 5; i++) {
      const r = onMeSegment(s, FAST_TEXT, T0 + i * 1200, opts())
      fired = r ?? fired
    }
    expect(fired).not.toBeNull()
    expect(fired!.kind).toBe('fast')
  })
  it('正常語速不誤報', () => {
    const s = createCoachingState()
    let last: unknown = null
    // 每段 8 units、間隔 4s(> gap 2.5s,不計連續,只算首段 1.5s)→ cpm 低
    for (let i = 1; i <= 5; i++) {
      last = onMeSegment(s, '我們一步一步來慢慢講', T0 + i * 4_000, opts())
    }
    expect(last).toBeNull()
  })
  it('冷卻期內不重複觸發', () => {
    const s = createCoachingState()
    let fired: ReturnType<typeof onMeSegment> = null
    for (let i = 1; i <= 5; i++) {
      const r = onMeSegment(s, FAST_TEXT, T0 + i * 1200, opts())
      fired = r ?? fired
    }
    expect(fired).not.toBeNull()
    // 30s 後再來一輪快速段:120s 冷卻內,不觸發(注意統計窗 90s 已淘舊前段)
    let second: ReturnType<typeof onMeSegment> = null
    for (let i = 1; i <= 5; i++) {
      const r = onMeSegment(s, FAST_TEXT, T0 + 30_000 + i * 1200, opts())
      second = r ?? second
    }
    expect(second).toBeNull()
  })
  it('個人基準生效:校準 200 CPM 的人更快觸發', () => {
    const s = createCoachingState()
    let fired: ReturnType<typeof onMeSegment> = null
    for (let i = 1; i <= 5; i++) {
      const r = onMeSegment(s, FAST_TEXT, T0 + 100_000 + i * 1200, opts({ baselineCpm: 200 }))
      fired = r ?? fired
    }
    expect(fired).not.toBeNull()
    expect(fired!.kind).toBe('fast')
  })
})

describe('onMeSegment 填充詞(filler)', () => {
  it('30s 內 ≥4 次 → filler', () => {
    const s = createCoachingState()
    let r: ReturnType<typeof onMeSegment> = null
    for (let i = 1; i <= 4; i++) {
      r = onMeSegment(s, '嗯', T0 + i * 3_000, opts())
    }
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('filler')
  })
  it('低於門檻不觸發', () => {
    const s = createCoachingState()
    let r: unknown = null
    for (let i = 1; i <= 3; i++) {
      r = onMeSegment(s, '嗯', T0 + i * 3_000, opts())
    }
    expect(r).toBeNull()
  })
})

describe('onMeSegment 獨白過長(monologue)', () => {
  // 提高 fast 基準以隔離 monologue 訊號
  const SLOW_OPTS = (): Parameters<typeof onMeSegment>[3] => ({ baselineCpm: 9999 })
  it('連續發言 > 75s 且量足 → monologue', () => {
    const s = createCoachingState()
    let r: ReturnType<typeof onMeSegment> = null
    // 每 2s 一段,共 40 段 = 78s,量足;fast 被高基準壓住,monologue 應先觸發
    for (let i = 1; i <= 40; i++) {
      r = onMeSegment(s, '我們的產品願景是幫助每個人更好地表達自己並且建立信心', T0 + i * 2_000, SLOW_OPTS())
      if (r) break
    }
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('monologue')
  })
  it('對方開口後重置獨白計時', () => {
    const s = createCoachingState()
    // 我講 40s
    for (let i = 1; i <= 20; i++) {
      onMeSegment(s, '我們的產品願景是幫助每個人更好地表達自己並且建立信心', T0 + i * 2_000, SLOW_OPTS())
    }
    // 對方插話 → 重置
    onThemSegment(s, '好的我了解了', T0 + 42_000, SLOW_OPTS())
    // 我再講 40s → 不應觸發(兩段獨白都 < 75s)
    let r: ReturnType<typeof onMeSegment> = null
    for (let i = 1; i <= 20; i++) {
      r = onMeSegment(s, '另外補充一下後續的安排還有三個面向要討論', T0 + 50_000 + i * 2_000, SLOW_OPTS())
    }
    expect(r).toBeNull()
  })
})

describe('checkInterrupt 搶話', () => {
  it('對方段送達 2s 內我方開口 → interrupt', () => {
    const s = createCoachingState()
    onThemSegment(s, '那我們請你說明一下這個案例的背景', T0, opts())
    const r = checkInterrupt(s, T0 + 1_500, opts())
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('interrupt')
  })
  it('間隔超過 2s → 不算', () => {
    const s = createCoachingState()
    onThemSegment(s, '那我們請你說明一下這個案例的背景', T0, opts())
    expect(checkInterrupt(s, T0 + 3_000, opts())).toBeNull()
  })
  it('冷卻期內不重複', () => {
    const s = createCoachingState()
    onThemSegment(s, '那我們請你說明一下這個案例的背景', T0, opts())
    expect(checkInterrupt(s, T0 + 1_500, opts())).not.toBeNull()
    onThemSegment(s, '第二個問題,關於團隊協作的經驗', T0 + 60_000, opts())
    expect(checkInterrupt(s, T0 + 61_000, opts())).toBeNull() // 180s 冷卻內
  })
})

describe('checkDeadAir 冷場', () => {
  it('8s 無語音 → dead_air', () => {
    const s = createCoachingState()
    onMeSegment(s, '我先說明一下現況', T0, opts())
    const r = checkDeadAir(s, T0 + 9_000, opts())
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('dead_air')
  })
  it('開場尚無語音 → 不報', () => {
    const s = createCoachingState()
    expect(checkDeadAir(s, T0 + 20_000, opts())).toBeNull()
  })
  it('300s 冷卻', () => {
    const s = createCoachingState()
    onMeSegment(s, '我先說明一下現況', T0, opts())
    expect(checkDeadAir(s, T0 + 9_000, opts())).not.toBeNull()
    onMeSegment(s, '好那我們繼續', T0 + 100_000, opts())
    expect(checkDeadAir(s, T0 + 109_000, opts())).toBeNull()
    expect(checkDeadAir(s, T0 + 400_001, opts())).not.toBeNull()
  })
})
