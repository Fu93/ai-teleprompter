/**
 * spring.ts — 可中斷彈簧動畫(rAF 積分器,retarget 時保留速度)
 *
 * 數值對應 Apple Island 慣例(boring.notch 實測):
 * - open:  response 0.42s、ζ≈0.8 → stiffness 224 / damping 24(約 3% 過衝)
 * - close: response 0.45s、ζ=1.0 → stiffness 195 / damping 28(臨界阻尼)
 * 換算:stiffness = (2π/response)²、damping = 2ζ·√stiffness
 */

import { useEffect, useRef, useState } from 'react'

export interface SpringConfig {
  stiffness?: number
  damping?: number
  /** 就位判定:|x-target| 與 |v| 同時小於此值 */
  precision?: number
}

export const SPRING_PRESETS = {
  /** 展開:帶一點彈性 */
  open: { stiffness: 224, damping: 24 },
  /** 收合:臨界阻尼,零彈跳 */
  close: { stiffness: 195, damping: 28 }
} as const

const MAX_DT_MS = 32
/** 積分子步:semi-implicit Euler 在 16ms 步長會注入數值阻尼(過衝 1.5%→0.17%);
 *  2ms 子步把誤差壓到 ~0.2%,開銷可忽略 */
const SUBSTEP_MS = 2

function normalizeCfg(cfg: SpringConfig): Required<SpringConfig> {
  return {
    stiffness: cfg.stiffness ?? SPRING_PRESETS.open.stiffness,
    damping: cfg.damping ?? SPRING_PRESETS.open.damping,
    precision: cfg.precision ?? 0.001
  }
}

export class SpringAnimator {
  value: number
  private velocity = 0
  target: number
  private cfg: Required<SpringConfig>
  private raf: number | null = null
  private lastAt: number | null = null
  private settleFired = false
  private readonly onUpdate: (value: number) => void
  private readonly onSettle?: (value: number) => void

  constructor(
    initial: number,
    target: number,
    cfg: SpringConfig,
    onUpdate: (value: number) => void,
    onSettle?: (value: number) => void
  ) {
    this.value = initial
    this.target = target
    this.cfg = normalizeCfg(cfg)
    this.onUpdate = onUpdate
    this.onSettle = onSettle
    // 惰性啟動:由 setTarget() 驅動(node 測試環境無 rAF 也可直接用 advance())
  }

  /** 改變目標:保留當前位置與速度(可中斷 retarget),可同時換阻尼 */
  setTarget(target: number, cfg?: SpringConfig): void {
    this.target = target
    if (cfg) this.cfg = normalizeCfg(cfg)
    if (this.settled) {
      this.value = target
      this.velocity = 0
      if (!this.settleFired) {
        this.settleFired = true
        this.onSettle?.(this.value)
      }
      return
    }
    this.settleFired = false
    if (this.raf === null) this.start()
  }

  stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.lastAt = null
  }

  get settled(): boolean {
    const p = this.cfg.precision
    return Math.abs(this.value - this.target) < p && Math.abs(this.velocity) < p
  }

  /** 積分一步(毫秒);rAF tick 與測試共用。內部切 2ms 子步保精度 */
  advance(dtMs: number): void {
    let remaining = Math.min(MAX_DT_MS, Math.max(0, dtMs))
    while (remaining > 0) {
      const step = Math.min(SUBSTEP_MS, remaining) / 1000
      const a = this.cfg.stiffness * (this.target - this.value) - this.cfg.damping * this.velocity
      this.velocity += a * step
      this.value += this.velocity * step
      remaining -= step * 1000
    }
    if (this.settled) {
      this.value = this.target
      this.velocity = 0
      if (!this.settleFired) {
        this.settleFired = true
        this.onSettle?.(this.value)
      }
    }
  }

  private start(): void {
    // node 測試環境無 rAF:保持手動模式(直接以 advance() 驅動)
    if (typeof requestAnimationFrame !== 'function') return
    this.lastAt = null
    this.raf = requestAnimationFrame(this.tick)
  }

  private tick = (now: number): void => {
    if (this.lastAt === null) this.lastAt = now
    const dt = Math.min(MAX_DT_MS, now - this.lastAt)
    this.lastAt = now
    this.advance(dt)
    this.onUpdate(this.value)
    if (this.settled) {
      this.stop()
      return
    }
    this.raf = requestAnimationFrame(this.tick)
  }
}

/**
 * React hook:布林驅動的 0→1 彈簧值。
 * active 變化時 retarget(保留速度)並切換 open/close 阻尼;
 * 值 > 0 期間保持 mounted(供退場動畫)。
 */
export function useSpringValue(active: boolean): { value: number; visible: boolean } {
  const [value, setValue] = useState(active ? 1 : 0)
  const [mounted, setMounted] = useState(active)
  const animatorRef = useRef<SpringAnimator | null>(null)
  // onSettle 閉包讀最新 active,避免捕獲過期值
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (!animatorRef.current) {
      // 首次建立:initial = target(已就位,不播入場動畫)
      animatorRef.current = new SpringAnimator(
        active ? 1 : 0,
        active ? 1 : 0,
        active ? SPRING_PRESETS.open : SPRING_PRESETS.close,
        (v) => setValue(v),
        () => {
          if (!activeRef.current) setMounted(false)
        }
      )
    }
    // 之後的 active 變化走 setTarget:保留當前位置與速度(可中斷改道),只換阻尼
    const target = active ? 1 : 0
    if (active) setMounted(true)
    animatorRef.current.setTarget(target, active ? SPRING_PRESETS.open : SPRING_PRESETS.close)
  }, [active])

  // 僅卸載時銷毀(不在 active 變化時重建,否則速度歸零 = cancel+restart)
  useEffect(
    () => () => {
      animatorRef.current?.stop()
      animatorRef.current = null
    },
    []
  )

  return { value, visible: mounted || active }
}
