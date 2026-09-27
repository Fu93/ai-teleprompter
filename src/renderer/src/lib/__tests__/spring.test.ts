import { describe, it, expect } from 'vitest'
import { SpringAnimator, SPRING_PRESETS } from '../spring'

/** 前進至收斂或步數上限;過衝 = 首次抵達目標後,越過目標的最遠距離 */
function runToSettle(s: SpringAnimator, maxFrames = 5000): { frames: number; overshoot: number } {
  let frames = 0
  let crossed = false
  let overshoot = 0
  const dir = s.target >= s.value ? 1 : -1
  while (!s.settled && frames < maxFrames) {
    s.advance(16)
    frames++
    if (!crossed) {
      crossed = dir === 1 ? s.value >= s.target : s.value <= s.target
    } else {
      overshoot = Math.max(overshoot, dir === 1 ? s.value - s.target : s.target - s.value)
    }
  }
  return { frames, overshoot }
}

describe('SpringAnimator', () => {
  it('open 預設帶過衝(ζ≈0.8),收斂到目標', () => {
    const s = new SpringAnimator(0, 1, SPRING_PRESETS.open, () => {})
    const { overshoot } = runToSettle(s)
    expect(s.value).toBe(1)
    expect(overshoot).toBeGreaterThan(0.005) // 有彈
    expect(overshoot).toBeLessThan(0.08) // 但不誇張
  })

  it('close 預設臨界阻尼,零(或極微)過衝', () => {
    const s = new SpringAnimator(1, 0, SPRING_PRESETS.close, () => {})
    const { overshoot } = runToSettle(s)
    expect(s.value).toBe(0)
    // 向 0 收合的「過衝」= 越過 0 往負值
    expect(overshoot).toBeLessThan(0.002)
  })

  it('retarget 保留速度:展開途中收合,平滑改道不重置', () => {
    const s = new SpringAnimator(0, 1, SPRING_PRESETS.open, () => {})
    // 展開 10 幀(正在加速上升)
    for (let i = 0; i < 10; i++) s.advance(16)
    const vAtSwitch = s.value
    expect(vAtSwitch).toBeGreaterThan(0.05)
    // 改道收合(close 阻尼):值應從當前位置連續下降,而非跳回 1 或 0
    s.setTarget(0, SPRING_PRESETS.close)
    let prev = s.value
    let monotonic = true
    let guard = 0
    while (!s.settled && guard < 5000) {
      s.advance(16)
      if (s.value > prev + 0.03) monotonic = false // 允許殘餘慣性的小幅上行(retarget 當幀 v≈3.6,減速後單幀最大上行 ≈0.025),不能暴衝
      prev = s.value
      guard++
    }
    expect(s.value).toBe(0)
    expect(monotonic).toBe(true)
  })

  it('advance 大 dt 切片不爆(NaN 防護)', () => {
    const s = new SpringAnimator(0, 1, SPRING_PRESETS.open, () => {})
    s.advance(5000)
    expect(Number.isFinite(s.value)).toBe(true)
  })

  it('onSettle 只在收斂時觸發一次', () => {
    let calls = 0
    const s = new SpringAnimator(0, 1, { stiffness: 400, damping: 40 }, () => {}, () => calls++)
    runToSettle(s)
    s.advance(16) // 已收斂後再 advance 不應再觸發
    expect(calls).toBe(1)
  })
})
