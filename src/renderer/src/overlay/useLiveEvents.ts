import { useEffect, useRef, useState } from 'react'

export type LiveEventKind = 'turn' | 'coaching' | 'panic'

export interface LiveEvent {
  kind: LiveEventKind
  text: string
  at: number
}

export interface UseLiveEventsResult {
  shownEvent: LiveEvent | null
  /** 無活躍事件但 shownEvent 還在退場動畫中(280ms) */
  leaving: boolean
}

/**
 * 靈動島事件主角輪替:事件發生時升為藥丸主角(key=at 重播彈入動畫),
 * 全部結束後播 280ms 淡出再卸載。優先序由呼叫端計算(turn > coaching > panic)。
 */
export function useLiveEvents(
  liveEventKind: LiveEventKind | null,
  liveEventText: string
): UseLiveEventsResult {
  const [shownEvent, setShownEvent] = useState<LiveEvent | null>(null)
  const eventLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (liveEventKind) {
      if (eventLeaveTimerRef.current) {
        clearTimeout(eventLeaveTimerRef.current)
        eventLeaveTimerRef.current = null
      }
      setShownEvent((prev) =>
        prev?.kind === liveEventKind && prev.text === liveEventText
          ? prev
          : { kind: liveEventKind, text: liveEventText, at: Date.now() }
      )
      return
    }
    // 事件結束:先播淡出動畫再卸載
    if (shownEvent && eventLeaveTimerRef.current === null) {
      eventLeaveTimerRef.current = setTimeout(() => {
        eventLeaveTimerRef.current = null
        setShownEvent(null)
      }, 280)
    }
  }, [liveEventKind, liveEventText, shownEvent])

  return { shownEvent, leaving: liveEventKind === null && shownEvent !== null }
}
