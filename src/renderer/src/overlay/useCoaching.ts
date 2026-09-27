/**
 * useCoaching.ts — 浮層端即時教練提示狀態
 *
 * main 的 coachingRules 引擎(語速/填充詞/搶話/冷場/獨白)送出
 * context:coaching;此 hook 顯示提示 8 秒後自動淡出。
 * main 端已有 per-kind 長冷卻(120s+),renderer 僅做 2s 保險防抖。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoachingKind } from '@shared/types'

const DISPLAY_MS = 8000

export interface CoachingHint {
  kind: CoachingKind
  message: string
}

export interface UseCoachingResult {
  /** 目前顯示中的提示(null = 無) */
  hint: CoachingHint | null
}

export function useCoaching(enabled: boolean): UseCoachingResult {
  const [hint, setHint] = useState<CoachingHint | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAtRef = useRef(0)

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
    const off = window.api.onCoaching((payload) => {
      if (payload.at - lastAtRef.current < 2000) return
      lastAtRef.current = payload.at
      setHint({ kind: payload.kind, message: payload.message })
      clearTimer()
      timerRef.current = setTimeout(() => setHint(null), DISPLAY_MS)
    })
    return () => {
      off()
      clearTimer()
    }
  }, [enabled, clearTimer])

  return { hint }
}
