import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CPM,
  PACE_BAND,
  PACE_WINDOW_MS,
  createPaceStabilizer,
  estimateCpm,
  paceEmitDecision,
  paceKey,
  paceVerdict
} from '../speakingPace'

const T0 = 1_000_000
/** 28 單位的段(與 coachingRules 的測試同一句,方便對照) */
const U28 = 28

describe('estimateCpm 瞬時語速', () => {
  it('連續短句:三段、間隔 1.2s → 單位數 ÷ 實際計入的發聲時間', () => {
    const s = [
      { t: T0, units: U28 },
      { t: T0 + 1_200, units: U28 },
      { t: T0 + 2_400, units: U28 }
    ]
    // activeMs = 1500(首段 credit) + 1200 + 1200 = 3900
    expect(estimateCpm(s, T0 + 2_400, PACE_WINDOW_MS)).toBeCloseTo(84 / (3_900 / 60_000), 5)
  })

  it('單段不足以判讀 → null(不編數字)', () => {
    expect(estimateCpm([{ t: T0, units: U28 }], T0, PACE_WINDOW_MS)).toBeNull()
  })

  it('單位數不足 → null', () => {
    const s = [
      { t: T0, units: 2 },
      { t: T0 + 1_200, units: 2 }
    ]
    expect(estimateCpm(s, T0 + 1_200, PACE_WINDOW_MS)).toBeNull()
  })

  it('發聲時間不足 → null:兩段、間隔 4s 的慢速語音不是 800 字/分', () => {
    const s = [
      { t: T0, units: 10 },
      { t: T0 + 4_000, units: 10 }
    ]
    expect(estimateCpm(s, T0 + 4_000, PACE_WINDOW_MS)).toBeNull()
  })

  it('窗外樣本不計:11 秒前的段不算進 10 秒窗', () => {
    const s = [
      { t: T0, units: U28 },
      { t: T0 + 1_200, units: U28 },
      { t: T0 + 2_400, units: U28 }
    ]
    // now 推進到第一段出窗(now - t0 >= 10s)後,只剩兩段 → activeMs 2700 < 3000
    expect(estimateCpm(s, T0 + 10_000, PACE_WINDOW_MS)).toBeNull()
  })

  it('停頓不計入發聲時間:間隔 3s 的兩段以首段 credit 計', () => {
    const s = [
      { t: T0, units: U28 },
      { t: T0 + 3_000, units: U28 }
    ]
    // 3s > 2.5s 不計 → activeMs 1500 < 3000 → null(不會變成「飆到 2240 字/分」)
    expect(estimateCpm(s, T0 + 3_000, PACE_WINDOW_MS)).toBeNull()
  })
})

describe('paceVerdict 三色判定', () => {
  it('超出 +10% → ahead;低於 −10% → behind;中間 → on_track', () => {
    expect(paceVerdict(240 * 1.2, 240)).toBe('ahead')
    expect(paceVerdict(240 * 0.8, 240)).toBe('behind')
    expect(paceVerdict(240, 240)).toBe('on_track')
  })

  it('恰好 ±10% 屬於 on_track(邊界不變色)', () => {
    expect(paceVerdict(240 * (1 + PACE_BAND), 240)).toBe('on_track')
    expect(paceVerdict(240 * (1 - PACE_BAND), 240)).toBe('on_track')
  })

  it('cpm null / 非正數 → null(不冒充判定)', () => {
    expect(paceVerdict(null, 240)).toBeNull()
    expect(paceVerdict(0, 240)).toBeNull()
  })

  it('未校準(baseline 0)以 DEFAULT_CPM 為基準', () => {
    expect(paceVerdict(DEFAULT_CPM + 1, 0)).toBe('on_track')
    expect(paceVerdict(DEFAULT_CPM * 1.5, 0)).toBe('ahead')
  })
})

describe('paceEmitDecision 發送政策', () => {
  const base = { prevKey: '300|on_track', cpmIsNull: false, now: 10_000, lastSentAt: 9_000, heartbeatMs: 2_000 }

  it('鍵變了 → 立刻送(畫面要改)', () => {
    expect(paceEmitDecision({ ...base, key: '900|ahead' })).toBe(true)
  })

  it('鍵沒變、有數字、未到心跳間隔 → 不送', () => {
    expect(paceEmitDecision({ ...base, key: '300|on_track' })).toBe(false)
  })

  it('鍵沒變、有數字、到了心跳 → 送(穩定時讀數不得自己消失)', () => {
    expect(paceEmitDecision({ ...base, key: '300|on_track', now: 11_000 })).toBe(true)
  })

  it('鍵沒變且已是 null → 不送(收起的訊號只送一次)', () => {
    expect(
      paceEmitDecision({ ...base, key: paceKey(null, null), prevKey: paceKey(null, null), cpmIsNull: true, now: 99_999 })
    ).toBe(false)
  })

  it('從數字變成 null → 送那一次(浮層才能立刻收起)', () => {
    expect(paceEmitDecision({ ...base, key: paceKey(null, null), cpmIsNull: true })).toBe(true)
  })
})

describe('createPaceStabilizer 顯示穩定器', () => {
  it('單次衝過邊界的樣本被濾掉:顏色不跳一格', () => {
    const st = createPaceStabilizer()
    st.push(300, 300)
    st.push(300, 300)
    const spike = st.push(9_000, 300) // 單次飆高:3 筆的中位數仍是 300
    expect(spike).toEqual({ cpm: 300, verdict: 'on_track' })
  })

  it('真實的持續變化兩筆就反映:沒有 EMA 的記憶尾巴', () => {
    const st = createPaceStabilizer()
    st.push(300, 300)
    st.push(300, 300)
    st.push(900, 300) // 第一筆新值還被中位數擋著
    expect(st.push(900, 300).verdict).toBe('ahead') // 第二筆立刻跟上(EMA 要 7 筆)
  })

  it('放慢回來同樣兩筆:第一筆仍在窗外,第二筆回到 on_track', () => {
    const st = createPaceStabilizer()
    st.push(900, 300)
    st.push(900, 300)
    st.push(900, 300)
    expect(st.push(300, 300).verdict).toBe('ahead')
    expect(st.push(300, 300).verdict).toBe('on_track')
  })

  it('null 會重置:下一個數字重新開始,不背著上一個人的節奏', () => {
    const st = createPaceStabilizer()
    st.push(9_000, 300)
    st.push(9_000, 300)
    expect(st.push(null, 300)).toEqual({ cpm: null, verdict: null })
    expect(st.push(300, 300)).toEqual({ cpm: 300, verdict: 'on_track' })
  })
})
