/**
 * usePace.ts — 浮層端瞬時節奏讀數(P4)
 *
 * main 每 ~2 秒心跳一次(見 main/liveCoaching.ts 的 PACE_HEARTBEAT_MS),
 * 這裡只做三件事:訂閱、8 秒過期清掃、把 null 當收起。
 *
 * 為什麼要有過期清掃:心跳是唯一的更新來源,而浮層在會議中可能被隱藏、
 * IPC 也可能在視窗重建的瞬間斷掉 —— 一顆停在畫面上的舊數字比沒有讀數更糟
 * (使用者會照著一個已經不成立的節奏調整自己)。8 秒 = 4 次心跳,足以容忍
 * 單次遺漏,又不會久到讓假數字看起來像真的。
 *
 * 為什麼不在這裡防抖:main 已經節流到 2 秒一次,而讀數延遲比防抖重要 ——
 * 使用者放慢之後,畫面應該在下一次心跳就反映,不是再等一層保險。
 */
import { useEffect, useRef, useState } from 'react'

const STALE_MS = 8_000

export interface PaceReadout {
  /** 中位數濾波後的瞬時語速(字/分) */
  cpm: number
  verdict: 'ahead' | 'on_track' | 'behind'
  /** 顯示用基準(個人校準值,未校準為 300) */
  baseline: number
}

export function usePace(enabled: boolean): PaceReadout | null {
  const [readout, setReadout] = useState<PaceReadout | null>(null)
  const staleRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled) {
      setReadout(null)
      return
    }
    const clearStale = (): void => {
      if (staleRef.current) {
        clearTimeout(staleRef.current)
        staleRef.current = null
      }
    }
    const off = window.api.onCoachingPace((p) => {
      clearStale()
      // null = 窗內語音不足(或場次重置):收起,不留著上一個數字。
      if (p.cpm === null || p.verdict === null) {
        setReadout(null)
        return
      }
      setReadout({ cpm: p.cpm, verdict: p.verdict, baseline: p.baseline })
      staleRef.current = setTimeout(() => setReadout(null), STALE_MS)
    })
    return () => {
      off()
      clearStale()
    }
  }, [enabled])

  return readout
}
