/**
 * usePanic.ts — 浮層端 panic 狀態機(對應 v3 usePanicButton)
 *
 * 流程:trigger()(按鈕或 Alt+P 熱鍵經 main)→ thinking → rescue 卡(12s 自動消失)。
 * AI 關閉時 main 直接送模板卡,不走 thinking。
 *
 * 不傳講稿:救援語境由 main 端的 live 上下文與 lastOverlayPayload 提供
 * (見 liveCoaching.handlePanic),參數傳了也只是被丟掉 —— 簽名誠實比「以為有傳」好。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RescuePayload } from '@shared/types'

export type PanicPhase = 'idle' | 'thinking' | 'rescue'

const RESCUE_DISPLAY_MS = 12000

export interface UsePanicResult {
  phase: PanicPhase
  rescue: RescuePayload | null
  errorMsg: string
  trigger(): void
  dismiss(): void
}

export function usePanic(onRescueShown?: () => void): UsePanicResult {
  const [phase, setPhase] = useState<PanicPhase>('idle')
  const [rescue, setRescue] = useState<RescuePayload | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onShownRef = useRef(onRescueShown)
  onShownRef.current = onRescueShown

  const clearTimer = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    const offThinking = window.api.onPanicThinking(() => {
      setPhase('thinking')
      setRescue(null)
      setErrorMsg('')
    })
    const offRescue = window.api.onPanicRescue((payload) => {
      setRescue(payload)
      setPhase('rescue')
      if (payload.sentence) {
        clearTimer()
        timerRef.current = setTimeout(() => {
          setPhase('idle')
          setRescue(null)
        }, RESCUE_DISPLAY_MS)
      }
      onShownRef.current?.()
    })
    const offError = window.api.onPanicError((m) => setErrorMsg(m))
    return () => {
      offThinking()
      offRescue()
      offError()
      clearTimer()
    }
  }, [clearTimer])

  const trigger = useCallback((): void => {
    void window.api.panicTrigger()
  }, [])

  const dismiss = useCallback((): void => {
    setPhase('idle')
    setRescue(null)
    setErrorMsg('')
    clearTimer()
  }, [clearTimer])

  return { phase, rescue, errorMsg, trigger, dismiss }
}
