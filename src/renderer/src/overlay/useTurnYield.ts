/**
 * useTurnYield.ts — 浮層端 turn-yield 提示狀態
 *
 * main 在對方講完問句/長段後送 context:turn-yield;此 hook 顯示
 * 「該你說話了」提示數秒後自動淡出。renderer 端再以 3s 防抖合併
 * main 已防抖過的事件(保險),我方發言(語音跟讀)會即時收掉提示。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TurnYieldPayload } from '@shared/types'

const HINT_DISPLAY_MS = 6000

export interface TurnYieldHint {
  kind: TurnYieldPayload['kind']
  question: boolean
}

export interface UseTurnYieldResult {
  /** 目前顯示中的提示(null = 無) */
  hint: TurnYieldHint | null
  /** 我方開口(語音跟讀聽到我講話)時呼叫:立刻收掉提示 */
  notifyMeSpeaking(): void
}

export function useTurnYield(enabled: boolean): UseTurnYieldResult {
  const [hint, setHint] = useState<TurnYieldHint | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setHint(null)
      clearTimer()
      return
    }
    let lastAt = 0
    const off = window.api.onTurnYield((payload) => {
      // 防抖:main 已 1.2s 防抖,此處僅擋重複/過期事件
      if (payload.at - lastAt < 3000) return
      lastAt = payload.at
      setHint({ kind: payload.kind, question: payload.question })
      clearTimer()
      timerRef.current = setTimeout(() => setHint(null), HINT_DISPLAY_MS)
    })
    return () => {
      off()
      clearTimer()
    }
  }, [enabled, clearTimer])

  const notifyMeSpeaking = useCallback((): void => {
    setHint(null)
    clearTimer()
  }, [clearTimer])

  return { hint, notifyMeSpeaking }
}
