/**
 * useTeleprompterEngine.ts — 把 TeleprompterEngine 接上 React 的薄層
 *
 * 職責:
 * - 以 RAF 驅動 engine.tick(performance.now())
 * - 離散變更立即 re-render;連續變更(scroll 位移/elapsed)節流至 5Hz
 * - scroll 模式每幀把 scrollPos 直接寫入 DOM(不經過 React,保持 60fps)
 * - 量測 scroll 容器尺寸餵給引擎(ResizeObserver;容器只存在於展開/貼鏡形態,
 *   所以呼叫端要把形態一起放進 measureKey,展開時才會重新量測)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { TeleprompterEngine } from '../lib/teleprompter/engine'
import type { EngineState } from '../lib/teleprompter/engine'
import { buildScriptModel } from '../lib/teleprompter/scriptModel'
import type { ScriptModel } from '../lib/teleprompter/scriptModel'
import type { OverlayDisplayMode } from '@shared/types'
import { debugLog } from '../lib/debug'

const CONTINUOUS_NOTIFY_INTERVAL_MS = 200

export interface UseTeleprompterEngineParams {
  content: string
  displayMode: OverlayDisplayMode
  rate: number
  scrollSpeed: number
  scrollElRef: RefObject<HTMLDivElement | null>
  /**
   * 影響 scroll 幾何的摘要(字體/行高,以及捲動容器這次存不存在)。
   * 變更時重新量測容器尺寸 —— 藥丸形態沒有容器,展開時量測才會發生,
   * 少了這一段引擎會一直以為「沒東西可捲」並把講稿標成 completed。
   */
  measureKey?: string
  /**
   * 現在的形態。藥丸(compact)沒有捲動容器,所以量測必須知道「現在該不該量、
   * 量到的東西屬不屬於當前形態」(見量測 effect 的說明)。
   */
  surface: 'expanded' | 'lens' | 'pill'
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
  /** scroll 模式的捲動容器是否已量測(藥丸/貼鏡形態為 false) */
  measured: boolean
  controls: TeleprompterControls
}

export function useTeleprompterEngine(params: UseTeleprompterEngineParams): UseTeleprompterEngineResult {
  const { content, displayMode, rate, scrollSpeed, scrollElRef, measureKey, surface } = params

  const [, setVersion] = useState(0)
  const versionRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const lastContinuousNotifyRef = useRef(0)
  const engineRef = useRef<TeleprompterEngine | null>(null)
  /** 除錯事件流用:只在狀態真的變化時記一筆(不是每幀) */
  const lastStatusRef = useRef<string | null>(null)

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

      // 除錯事件流:狀態轉換是「什麼時候發生什麼」的主時間軸。
      // 只在真的變化時記(每幀記會把 200 筆緩衝瞬間灌滿,反而看不到事件)。
      // 未啟用除錯時 debugLog 是 no-op。
      if (st.status !== lastStatusRef.current) {
        lastStatusRef.current = st.status
        debugLog('engine', `狀態 → ${st.status}`, {
          mode: engine.displayMode,
          elapsedMs: Math.round(st.elapsedMs),
          sentence: st.sentenceIndex
        })
      }

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
      const engine = engineRef.current
      const node = scrollElRef.current
      // 只量「現在真的掛在畫面上、而且屬於當前形態」的那個捲動容器。
      //
      // 為什麼需要這道防線(實測抓到的兩種幽靈幾何):
      //   - 收合成藥丸時這個 effect 仍會重跑一次(形態是 measureKey 的一部分),
      //     而此時 scrollRef.current 還指著剛被卸載的節點 —— 分離的節點沒有佈局,
      //     scrollHeight/clientHeight 都是 0,餵進引擎會讓 maxScroll 退化成 40px,
      //     播放不到 100ms 就被標成 completed,進度條一次跳到底。
      //   - morph 途中容器還連著,但視窗已經被形狀彈簧縮到藥丸尺寸,量到的是
      //     過渡幾何(寬度變窄 → 文字重排 → scrollHeight 反而暴增)。
      // 兩者都不是「使用者正在看的那個版面」,量了比不量更糟。
      if (!engine || !node || !node.isConnected) return
      const host = node.closest('[data-overlay-surface]')?.getAttribute('data-overlay-surface')
      if (host !== surface) return
      engine.setOptions({ totalH: node.scrollHeight, wrapH: node.clientHeight })
      // 量測完成要讓畫面知道:進度線能不能顯示取決於「捲動範圍是否已知」,
      // 而這是一個 effect 內的 mutation,不 bump 的話 UI 永遠停在未量測那一帧。
      bump()
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollElRef, model, displayMode, measureKey, surface, bump])

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
    measured: engine.measured,
    controls
  }
}
