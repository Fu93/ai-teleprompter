/**
 * useCoaching.ts — 浮層端即時教練提示狀態
 *
 * main 的 coachingRules 引擎(語速/填充詞/搶話/冷場/獨白)送出
 * context:coaching;此 hook 顯示提示 8 秒後自動淡出。
 * main 端已有 per-kind 長冷卻(120s+),renderer 僅做 2s 保險防抖。
 *
 * ── 這一輪新增:本場靜默 ──
 *   教練提示的問題不是「太吵」,是**使用者無法表達「這一種我現在不想聽」**。
 *   原本只有兩種狀態:永遠開、永久關(設定檔)。中間缺了整個「這場先不要
 *   提醒我搶話」—— 而那正是使用者在會議中真正想要的粒度:
 *   他可能覺得「冷場提醒」很有用,但正在一個需要自己主動講話的場合,
 *   「搶話提醒」只會讓他更緊張。
 *
 *   為什麼是 **session 級、不寫設定檔**:
 *     - 寫進設定檔 = 永久。使用者按了「本場靜默」三小時後再開下一場,
 *       會發現自己再也收不到提示,而且不知道要去哪裡關掉 —— 那是比沒有
 *       這個功能更糟的結果。
 *     - 關掉 App 即失效 = 每次會議都是一個乾淨的重新評估。
 *
 *   為什麼不做「全域靜音熱鍵」(計畫裡明確排除的選項):
 *     全域熱鍵已經六顆,再塞第七顆會讓「該你說話了」這種**救場**提示
 *     也在無意間被關掉。使用者按錯一次,接下來對方問問題時沒有提示 ——
 *     而那正是浮層存在的理由。session 靜默刻意**不影響 turn-yield**。
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
  /**
   * 被本場靜默的訊號種類(空集合 = 沒靜默任何東西)。
   * 供浮層在提示條上畫出「已靜默:搶話」,否則使用者會忘記自己按過。
   */
  mutedKinds: CoachingKind[]
  /** 靜默這一種(kind)直到會議結束 */
  muteKind: (kind: CoachingKind) => void
  /** 取消全部靜默 */
  unmuteAll: () => void
}

export function useCoaching(enabled: boolean): UseCoachingResult {
  const [hint, setHint] = useState<CoachingHint | null>(null)
  const [mutedKinds, setMutedKinds] = useState<CoachingKind[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAtRef = useRef(0)
  /**
   * mutedKinds 的 ref 鏡像。
   *
   * 為什麼要鏡像而不是直接把 mutedKinds 放進 effect 的依賴:依賴它的話,
   * 每靜默一種訊號就取消並重建一次 IPC 訂閱 —— 在使用者正要說話的會議中
   * 斷事件流,比多跑一次 if 糟糕得多。
   *
   * 宣告在 effect **之前**:effect 的回呼雖然在 render 之後才執行,但
   * `const` 是 block-scoped,在宣告之前引用它會是 TDZ 錯誤,而那是在
   * 掛載時才爆 —— 症狀是浮層整個空白,與真正的成因相隔十萬八千里。
   */
  const mutedRef = useRef<CoachingKind[]>(mutedKinds)
  mutedRef.current = mutedKinds

  const clearTimer = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const muteKind = useCallback((kind: CoachingKind): void => {
    // 已靜默的按下去 = 取消靜默(同一顆鈕做兩件事)。
    // 否則使用者要另外找一顆「取消」的鈕 —— 而那顆鈕在浮層有限的空間裡
    // 會佔掉一個位置給一個低頻需求。
    setMutedKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]))
  }, [])

  const unmuteAll = useCallback((): void => {
    setMutedKinds([])
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
      // 被靜默的種類:訊號不顯示。時間戳照樣更新 —— 這是刻意的,
      // 讓「同一句話在 2 秒內重送」仍然被防抖擋掉,而不是被當成新訊號
      // 重新走一次靜默判斷(結果一樣,但多一次 setState 的機會)。
      if (mutedRef.current.includes(payload.kind)) return
      setHint({ kind: payload.kind, message: payload.message })
      clearTimer()
      timerRef.current = setTimeout(() => setHint(null), DISPLAY_MS)
    })
    return () => {
      off()
      clearTimer()
    }
  }, [enabled, clearTimer])

  // 設定層的開關被關掉時,本場靜默也該失效:使用者已經明確表達
  // 「我不要這個」,留著一個看不見的靜默狀態只會在下次開啟時生效,
  // 而那是他沒有要求過的。
  useEffect(() => {
    if (!enabled) setMutedKinds([])
  }, [enabled])

  return { hint, mutedKinds, muteKind, unmuteAll }
}
