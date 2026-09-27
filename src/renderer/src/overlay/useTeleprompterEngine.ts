/**
 * useTeleprompterEngine.ts — 把 TeleprompterEngine 接上 React 的薄層
 *
 * 職責:
 * - 以 RAF 驅動 engine.tick(performance.now())
 * - 離散變更立即 re-render;連續變更(scroll 位移/elapsed)節流至 5Hz
 * - scroll 模式每幀把 scrollPos 直接寫入 DOM(不經過 React,保持 60fps)
 * - 量測 scroll 容器尺寸餵給引擎(ResizeObserver)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { TeleprompterEngine } from '../lib/teleprompter/engine'
import type { EngineState } from '../lib/teleprompter/engine'
import { buildScriptModel } from '../lib/teleprompter/scriptModel'
import type { ScriptModel } from '../lib/teleprompter/scriptModel'
import type { OverlayDisplayMode } from '@shared/types'

const CONTINUOUS_NOTIFY_INTERVAL_MS = 200

export interface UseTeleprompterEngineParams {
  content: string
  displayMode: OverlayDisplayMode
  rate: number
  scrollSpeed: number
  scrollElRef: RefObject<HTMLDivElement | null>
  /** 影響 scroll 內容高度的設定摘要(如字體/行高);變更時重新量測 */
  measureKey?: string
}

export interface TeleprompterControls {
  play(): void
  pause(): void
  toggle(): void
  restart(): void
  next(): void
  prev(): void
}

export interface UseTeleprompterEngineResult {
  model: ScriptModel
  state: EngineState | null
  remainingMs: number | null
  progress: number
  controls: TeleprompterControls
}

export function useTeleprompterEngine(params: UseTeleprompterEngineParams): UseTeleprompterEngineResult {
  const { content, displayMode, rate, scrollSpeed, scrollElRef, measureKey } = params

  const [, setVersion] = useState(0)
  const versionRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const lastContinuousNotifyRef = useRef(0)
  const engineRef = useRef<TeleprompterEngine | null>(null)

  // 講稿加工(純函數);content 變更時重建
  const model = useMemo(() => buildScriptModel(content), [content])

  const bump = useCallback((): void => {
    versionRef.current += 1
    setVersion(versionRef.current)
  }, [])

  // 引擎實例:模型換了才重建(保留同一實例的播放狀態跨 re-render)
  if (!engineRef.current || engineRef.current.model !== model) {
    engineRef.current = new TeleprompterEngine(model, { rate, scrollSpeed }, displayMode)
  }

  // ── RAF 迴圈 ──
  const tickFrame = useCallback(
    (now: number): void => {
      const engine = engineRef.current
      if (!engine) {
        rafRef.current = null
        return
      }

      const change = engine.tick(now)
      const st = engine.getState()

      // scroll 模式:每幀直寫 DOM,不觸發 React render
      if (engine.displayMode === 'scroll' && scrollElRef.current) {
        scrollElRef.current.scrollTop = st.scrollPos
      }

      const shouldNotify =
        change === 'discrete' ||
        (change === 'continuous' && now - lastContinuousNotifyRef.current >= CONTINUOUS_NOTIFY_INTERVAL_MS)
      if (shouldNotify) {
        lastContinuousNotifyRef.current = now
        bump()
      }

      if (st.status === 'playing') {
        rafRef.current = requestAnimationFrame(tickFrame)
      } else {
        rafRef.current = null
      }
    },
    [scrollElRef, bump]
  )

  const ensureLoop = useCallback((): void => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tickFrame)
    }
  }, [tickFrame])

  const stopLoop = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // ── 同步選項與模式 ──
  useEffect(() => {
    engineRef.current?.setOptions({ rate, scrollSpeed })
  }, [rate, scrollSpeed])

  useEffect(() => {
    engineRef.current?.setDisplayMode(displayMode)
    bump()
  }, [displayMode, bump])

  // scroll 容器尺寸 → 引擎(內容/字體/行高/模式變更時重新量測)
  useEffect(() => {
    const el = scrollElRef.current
    if (!el) return
    const update = (): void => {
      engineRef.current?.setOptions({ totalH: el.scrollHeight, wrapH: el.clientHeight })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollElRef, model, displayMode, measureKey])

  // 卸載清理
  useEffect(
    () => () => {
      stopLoop()
    },
    [stopLoop]
  )

  // ── 控制介面 ──
  const controls = useMemo<TeleprompterControls>(
    () => ({
      play: () => {
        engineRef.current?.play()
        ensureLoop()
        bump()
      },
      pause: () => {
        engineRef.current?.pause()
        stopLoop()
        bump()
      },
      toggle: () => {
        const engine = engineRef.current
        if (!engine) return
        engine.toggle()
        if (engine.getState().status === 'playing') ensureLoop()
        else stopLoop()
        bump()
      },
      restart: () => {
        engineRef.current?.restart()
        ensureLoop()
        bump()
      },
      next: () => {
        engineRef.current?.manualNext()
        bump()
      },
      prev: () => {
        engineRef.current?.manualPrev()
        bump()
      }
    }),
    [ensureLoop, stopLoop, bump]
  )

  const engine = engineRef.current
  return {
    model,
    state: engine.getState(),
    remainingMs: engine.getRemainingMs(),
    progress: engine.progress,
    controls
  }
}
