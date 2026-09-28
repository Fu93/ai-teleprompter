import { useCallback, useEffect, useRef } from 'react'
import { SpringAnimator, SPRING_PRESETS } from '../lib/spring'
import type { AppSettings } from '@shared/types'

/** 進入藥丸/貼鏡模式前的視窗尺寸(morph 動畫的還原基準;module-level 供切頁保留) */
const expandedSize = { current: null as { w: number; h: number } | null }
const lensPrevSize = { current: null as { w: number | null; h: number | null } | null }

export interface UseMorphParams {
  patchOverlay: (patch: Partial<AppSettings['overlay']>) => Promise<void>
}

export interface UseMorphResult {
  /** 以彈簧把視窗從目前尺寸 morph 到 (toW,toH);isOpening 決定阻尼(open 有彈/close 無彈)。
   *  settleSize = 收斂時寫入設定的最終尺寸(通常等於 toW/toH) */
  morphSize: (toW: number, toH: number, isOpening: boolean, settleSize: { w: number; h: number }) => void
  enterCompact: (o: AppSettings['overlay']) => void
  exitCompact: () => void
  enterLens: (o: AppSettings['overlay']) => void
  exitLens: () => void
}

/**
 * 藥丸/貼鏡 morph:彈簧驅動視窗尺寸(開合分離阻尼)。
 * rAF 彈簧積分器:展開用 open(ζ≈0.8 帶彈)、收合用 close(臨界阻尼零彈跳);
 * 每幀 overlaySetSizeLive(不落盤),收斂時 onSettle 才以 overlaySetSize 定案(寫入設定)。
 * 注意:此 hook 必須在呼叫端的 early return 之前呼叫(hook 數一致性,React #310)。
 */
export function useMorph(params: UseMorphParams): UseMorphResult {
  const { patchOverlay } = params

  const sizeSpringRef = useRef<SpringAnimator | null>(null)
  /** morph 定案後的「原始展開尺寸」;進入貼鏡/藥丸前的還原基準 */
  const settledSizeRef = useRef<{ w: number; h: number } | null>(null)

  const stopSizeSpring = useCallback((): void => {
    sizeSpringRef.current?.stop()
    sizeSpringRef.current = null
  }, [])

  useEffect(
    () => () => stopSizeSpring(),
    [stopSizeSpring]
  )

  const morphSize = useCallback(
    (toW: number, toH: number, isOpening: boolean, settleSize: { w: number; h: number }): void => {
      const startW = window.innerWidth
      const startH = window.innerHeight
      // 目標就是目前尺寸:直接定案,不播動畫
      if (startW === toW && startH === toH) {
        settledSizeRef.current = settleSize
        void window.api.overlaySetSize(toW, toH)
        return
      }
      settledSizeRef.current = null
      stopSizeSpring()
      const animator = new SpringAnimator(
        0,
        1,
        isOpening ? SPRING_PRESETS.open : SPRING_PRESETS.close,
        () => {},
        () => {
          settledSizeRef.current = settleSize
          void window.api.overlaySetSize(settleSize.w, settleSize.h)
        }
      )
      sizeSpringRef.current = animator
      const wSpan = toW - startW
      const hSpan = toH - startH
      let lastAt: number | null = null
      const tick = (now: number): void => {
        if (sizeSpringRef.current !== animator) return // 已被新的 morph 取代
        const dt = lastAt === null ? 16.7 : Math.min(64, now - lastAt)
        lastAt = now
        animator.advance(dt)
        const p = animator.value
        void window.api.overlaySetSizeLive(Math.round(startW + wSpan * p), Math.round(startH + hSpan * p))
        if (animator.settled) {
          sizeSpringRef.current = null // onSettle 已在 advance() 內定案
        } else {
          requestAnimationFrame(tick)
        }
      }
      requestAnimationFrame(tick)
    },
    [stopSizeSpring]
  )

  const enterCompact = useCallback(
    (o: AppSettings['overlay']): void => {
      // 原始展開尺寸:從「最後定案的展開尺寸」取;直接從貼鏡進來時用 lensPrevSize,
      // 都沒有才用設定值(morph 途中 o.width/height 尚未定案,不可用)
      const prevLens = lensPrevSize.current
      const fromLens = prevLens && prevLens.w !== null && prevLens.h !== null ? { w: prevLens.w, h: prevLens.h } : null
      const expanded = settledSizeRef.current ?? fromLens ?? { w: o.width, h: o.height }
      expandedSize.current = expanded
      void patchOverlay({ compact: true })
      morphSize(460, 56, false, expanded)
    },
    [patchOverlay, morphSize]
  )

  const exitCompact = useCallback((): void => {
    const size = expandedSize.current ?? settledSizeRef.current ?? { w: 720, h: 260 }
    void patchOverlay({ compact: false })
    morphSize(size.w, size.h, true, size)
  }, [patchOverlay, morphSize])

  const enterLens = useCallback(
    (o: AppSettings['overlay']): void => {
      const expanded =
        settledSizeRef.current ??
        (o.compact ? expandedSize.current : null) ??
        { w: o.width, h: o.height }
      lensPrevSize.current = expanded
      void patchOverlay({ lensMode: true, compact: false })
      morphSize(420, 170, false, expanded)
    },
    [patchOverlay, morphSize]
  )

  const exitLens = useCallback((): void => {
    const prev = lensPrevSize.current
    // prev.w === null 表示進貼鏡前本來就是藥丸:還原回藥丸而非強制展開
    const size = prev && prev.w !== null && prev.h !== null ? { w: prev.w, h: prev.h } : null
    if (!size) {
      void patchOverlay({ lensMode: false, compact: true })
      morphSize(460, 56, true, { w: 720, h: 260 })
      return
    }
    void patchOverlay({ lensMode: false })
    morphSize(size.w, size.h, true, size)
  }, [patchOverlay, morphSize])

  return { morphSize, enterCompact, exitCompact, enterLens, exitLens }
}
