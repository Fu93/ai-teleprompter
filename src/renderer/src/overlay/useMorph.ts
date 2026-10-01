import { useCallback, useEffect, useRef, useState } from 'react'
import { SpringAnimator, SPRING_PRESETS } from '../lib/spring'
import type { AppSettings } from '@shared/types'
import { clampPillScale, LENS_SIZE, PILL_SIZE, pillSizeOf } from '@shared/overlayShapes'

/** 進入藥丸/貼鏡模式前的視窗尺寸(morph 動畫的還原基準;module-level 供切頁保留) */
const expandedSize = { current: null as { w: number; h: number } | null }
const lensPrevSize = { current: null as { w: number | null; h: number | null } | null }

/**
 * 藥丸與貼鏡模式的視窗尺寸。
 *
 * 唯一定義:進入/退出的 morph 與「啟動時還原上次形態」都要用同一組數字,
 * 否則還原出來的尺寸會與切換後的尺寸差幾px,變成看起來像疊影的兩條邊。
 *
 * 現在真正的定義在 @shared/overlayShapes:main 端要用同一組數字去設視窗最小尺寸,
 * 而「動畫的目標」與「視窗的下限」分開寫一定會漂移(那就是上一輪的 bug)。
 * 這裡保留 re-export,呼叫端不必改 import 路徑(PILL_SIZE 是 1.00× 的相容常數;
 * 實際使用的尺寸一律走 pillSizeOf(設定的倍率))。
 */
export { PILL_SIZE, LENS_SIZE }

export interface UseMorphParams {
  patchOverlay: (patch: Partial<AppSettings['overlay']>) => Promise<void>
}

export interface UseMorphResult {
  /** 以彈簧把視窗從目前尺寸 morph 到 (toW,toH);isOpening 決定阻尼(open 有彈/close 無彈)。
   *  settleSize = 收斂時寫入設定的展開尺寸(退出藥丸/貼鏡時要還原的大小);
   *  capsule = 目標形態是不是膠囊(藥丸),fromCapsule = 目前形態是不是膠囊 ——
   *  兩者用來驅動輪廓半徑的插值(見下方 --morph-p);
   *  pillScale = 藥丸倍率(只影響膠囊半徑的插值基準,未給時沿用上一次)。 */
  morphSize: (
    toW: number,
    toH: number,
    isOpening: boolean,
    settleSize: { w: number; h: number },
    capsule: boolean,
    fromCapsule: boolean,
    pillScale?: number
  ) => void
  enterCompact: (o: AppSettings['overlay']) => void
  exitCompact: () => void
  enterLens: (o: AppSettings['overlay']) => void
  exitLens: () => void
  /** morph 彈簧仍在跑。呼叫端據此:停用折射(morph 途中位移圖尺寸不符會扭曲)、
   *  套用輪廓半徑插值 class。 */
  morphing: boolean
}

interface Springs {
  w: SpringAnimator
  h: SpringAnimator
  /** 0 = 圓角矩形(.overlay-radius,20px)、1 = 膠囊(高的一半) */
  shape: SpringAnimator
}

/** px 彈簧的收斂門檻用 0.2px(0.001px 會拖長尾端);圓角程度用 0.002 */
function sizeCfg(isOpening: boolean): { stiffness: number; damping: number; precision: number } {
  return {
    ...(isOpening ? SPRING_PRESETS.open : SPRING_PRESETS.close),
    precision: 0.2
  }
}
function shapeCfg(isOpening: boolean): { stiffness: number; damping: number; precision: number } {
  return {
    ...(isOpening ? SPRING_PRESETS.open : SPRING_PRESETS.close),
    precision: 0.002
  }
}

/**
 * 藥丸/貼鏡 morph:彈簧驅動視窗尺寸(開合分離阻尼)。
 *
 * 這一版把「每次 morph 都重建動畫器」改成**三個長壽命彈簧**(寬、高、圓角程度),
 * 改道一律走 setTarget() —— spring.ts 的 setTarget 會保留當前速度,所以連續點擊
 * 「收合成藥丸 / 展開」時是平滑改道,而不是速度歸零後重新起步(那是看得出來的頓點)。
 *
 * 尺寸用絕對像素(不是 0→1 的正規化進度):正規化進度在不同目標之間沒有共同座標,
 * 改道時速度就失去意義 —— 這正是舊版「stop + new」的根因。
 * 每幀 overlaySetSizeLive(不落盤),三條彈簧都收斂時才以 overlaySetSize 定案(寫入設定)。
 * 另外每幀把輪廓插值寫進 CSS 變數(--morph-p / --pill-r),藥丸與展開共用同一條曲線。
 *
 * 注意:此 hook 必須在呼叫端的 early return 之前呼叫(hook 數一致性,React #310)。
 */
export function useMorph(params: UseMorphParams): UseMorphResult {
  const { patchOverlay } = params

  const springsRef = useRef<Springs | null>(null)
  /** 目前跑著的 morph 的識別物:換掉它就等於取消舊的 rAF 迴圈 */
  const runRef = useRef<object | null>(null)
  /** morph 定案後的「原始展開尺寸」;進入貼鏡/藥丸前的還原基準 */
  const settledSizeRef = useRef<{ w: number; h: number } | null>(null)
  const [morphing, setMorphing] = useState(false)
  /** 最後一次 morph 用的藥丸倍率:退出藥丸/貼鏡的路徑手上沒有 settings,靠它算膠囊半徑 */
  const pillScaleRef = useRef(1)

  /** 第一次 morph 才建立(初始值 = 當下的視窗尺寸與形態,不播入場動畫) */
  const ensureSprings = useCallback((fromCapsule: boolean): Springs => {
    if (!springsRef.current) {
      const w = window.innerWidth
      const h = window.innerHeight
      const s = fromCapsule ? 1 : 0
      springsRef.current = {
        w: new SpringAnimator(w, w, sizeCfg(false), () => {}),
        h: new SpringAnimator(h, h, sizeCfg(false), () => {}),
        shape: new SpringAnimator(s, s, shapeCfg(false), () => {})
      }
    }
    return springsRef.current
  }, [])

  /**
   * 輪廓插值:--morph-p(0 = 圓角矩形、1 = 膠囊)給 CSS 的 border-radius calc 用,
   * --pill-r 是藥丸的設計半徑(= 目前倍率下的 PILL_BASE.h / 2)。
   *
   * 這裡刻意用設計尺寸而不是「目前視窗高度的一半」:morph 的目標一定是藥丸尺寸,
   * 而定義上膠囊半徑就是它的高度一半 —— 但「藥丸 → 貼鏡」的目標視窗是 420×170,
   * 用目前高度來算會得到 85px 的圓角(整個貼鏡變成圓牌),那是錯的。
   * 每個 morph 都從同一組數字開始,輪廓才有一致的基準。
   */
  const writeShapeVars = useCallback((p: number, pillScale: number): void => {
    const style = document.documentElement.style
    style.setProperty('--morph-p', String(p))
    style.setProperty('--pill-r', `${pillSizeOf(pillScale).h / 2}px`)
  }, [])

  // 僅卸載時停掉迴圈與彈簧(不在這裡 setState:元件已在卸載中)
  useEffect(
    () => () => {
      runRef.current = null
      springsRef.current?.w.stop()
      springsRef.current?.h.stop()
      springsRef.current?.shape.stop()
    },
    []
  )

  const morphSize = useCallback(
    (
      toW: number,
      toH: number,
      isOpening: boolean,
      settleSize: { w: number; h: number },
      capsule: boolean,
      fromCapsule: boolean,
      pillScale?: number
    ): void => {
      const startW = window.innerWidth
      const startH = window.innerHeight
      const springs = ensureSprings(fromCapsule)
      const targetShape = capsule ? 1 : 0
      const scale = clampPillScale(pillScale ?? pillScaleRef.current)
      pillScaleRef.current = scale

      /**
       * 定案:morph 收斂時把結果寫回去。
       *
       * settleSize 是「展開尺寸」(退出藥丸/貼鏡時要還原的大小),不是目標尺寸 ——
       * 而視窗尺寸現在由 main 按形態決定(non-expanded 形態下 overlaySetSize 只會把
       * 視窗帶到該形態的設計尺寸),所以一次呼叫就夠了:
       * 在藥丸/貼鏡時它不會把視窗撐回展開大小,在展開時它就是使用者要的尺寸。
       * (先前這一擊會觸發 applyOverlayWindowSettings 把視窗撐回展開尺寸,是藥丸
       *  與貼鏡「一收合就彈回 720×260」的原因,探針實測:250ms 421×170 → 500ms 720×260)
       */
      const settle = (): void => {
        settledSizeRef.current = settleSize
        void window.api.overlaySetSize(settleSize.w, settleSize.h)
        writeShapeVars(targetShape, scale)
      }

      // 目標就是目前尺寸與形態:直接定案,不播動畫(定案的順序同 settle 的說明)
      if (startW === toW && startH === toH && Math.abs(springs.shape.value - targetShape) < 0.01) {
        settle()
        return
      }

      settledSizeRef.current = null
      springs.w.setTarget(toW, sizeCfg(isOpening))
      springs.h.setTarget(toH, sizeCfg(isOpening))
      springs.shape.setTarget(targetShape, shapeCfg(isOpening))

      const run = {}
      runRef.current = run
      setMorphing(true)

      // 這一圈只負責「把彈簧的當前值寫出去」與「三個都收斂時定案」。
      // 積分由每個 SpringAnimator 自己的 rAF 負責(setTarget 會惰性啟動,
      // 收斂時自己停)—— 兩邊都 advance 的話等於每帧前進两格,
      // morph 會快一倍,而且尺寸與寫入的時序完全失控。
      const tick = (): void => {
        if (runRef.current !== run) return // 已被新的 morph 取代
        writeShapeVars(springs.shape.value, scale)
        void window.api.overlaySetSizeLive(Math.round(springs.w.value), Math.round(springs.h.value))
        if (springs.w.settled && springs.h.settled && springs.shape.settled) {
          runRef.current = null
          settle()
          setMorphing(false)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    [ensureSprings, writeShapeVars]
  )

  const enterCompact = useCallback(
    (o: AppSettings['overlay']): void => {
      // 原始展開尺寸:從「最後定案的展開尺寸」取;直接從貼鏡進來時用 lensPrevSize,
      // 都沒有才用設定值(morph 途中 o.width/height 尚未定案,不可用)
      const prevLens = lensPrevSize.current
      const fromLens = prevLens && prevLens.w !== null && prevLens.h !== null ? { w: prevLens.w, h: prevLens.h } : null
      const expanded = settledSizeRef.current ?? fromLens ?? { w: o.width, h: o.height }
      expandedSize.current = expanded
      // 藥丸要多大由設定的 pillScale 決定(0.8×–1.3×),不是常數 —— 見 overlayShapes.ts
      const pill = pillSizeOf(o.pillScale)
      void patchOverlay({ compact: true })
      morphSize(pill.w, pill.h, false, expanded, true, false, o.pillScale)
    },
    [patchOverlay, morphSize]
  )

  const exitCompact = useCallback((): void => {
    const size = expandedSize.current ?? settledSizeRef.current ?? { w: 720, h: 260 }
    void patchOverlay({ compact: false })
    morphSize(size.w, size.h, true, size, false, true)
  }, [patchOverlay, morphSize])

  const enterLens = useCallback(
    (o: AppSettings['overlay']): void => {
      const expanded =
        settledSizeRef.current ??
        (o.compact ? expandedSize.current : null) ??
        { w: o.width, h: o.height }
      lensPrevSize.current = expanded
      void patchOverlay({ lensMode: true, compact: false })
      morphSize(LENS_SIZE.w, LENS_SIZE.h, false, expanded, false, o.compact, o.pillScale)
    },
    [patchOverlay, morphSize]
  )

  const exitLens = useCallback((): void => {
    const prev = lensPrevSize.current
    // prev.w === null 表示進貼鏡前本來就是藥丸:還原回藥丸而非強制展開
    const size = prev && prev.w !== null && prev.h !== null ? { w: prev.w, h: prev.h } : null
    if (!size) {
      const pill = pillSizeOf(pillScaleRef.current)
      void patchOverlay({ lensMode: false, compact: true })
      morphSize(pill.w, pill.h, true, { w: 720, h: 260 }, true, false)
      return
    }
    void patchOverlay({ lensMode: false })
    morphSize(size.w, size.h, true, size, false, false)
  }, [patchOverlay, morphSize])

  return { morphSize, enterCompact, exitCompact, enterLens, exitLens, morphing }
}
