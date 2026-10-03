import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/types'
import {
  bestMatchPosition,
  buildChunks,
  chunkAtPosition,
  normalizeForMatch,
  type FollowChunk
} from '../lib/follow'
import { AudioSegmenter } from '../lib/audio/segmenter'
import { WhisperClient, type WhisperModelKey } from '../lib/audio/whisperClient'
import { debugLog } from '../lib/debug'
import type { TeleprompterControls } from './useTeleprompterEngine'

export type FollowStatus = 'idle' | 'loading' | 'listening' | 'error'

export interface UseFollowModeParams {
  settings: AppSettings | null
  /** 引擎控制存 ref:startFollow 時暫停自動捲動(controls 在呼叫端較晚宣告,延後到執行期存取) */
  controlsRef: React.MutableRefObject<TeleprompterControls | null>
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** 我方開口(≥2 字或填充詞)→ 即時收掉「該你說話了」提示 */
  onMeSpeech?: () => void
}

export interface UseFollowModeResult {
  followStatus: FollowStatus
  /** 一次性 effect(自動播放)讀最新狀態用,避免閉包捕獲 stale 值 */
  followStatusRef: React.MutableRefObject<FollowStatus>
  followMsg: string
  lastHeard: string
  activeChunk: number
  followProgress: number
  /** 跟讀中高亮的 chunk 清單;非跟讀時為 null(scroll surface 退回純文字) */
  followChunks: FollowChunk[] | null
  /** 即時輸入音量(0~1),藥丸音柱 rAF 直寫用 */
  followLevelRef: React.MutableRefObject<number>
  chunkElsRef: React.MutableRefObject<Map<number, HTMLSpanElement>>
  startFollow: () => Promise<void>
  stopFollow: () => void
  toggleFollow: () => void
  /** 跟隨中滾輪微調:調整偏移而非直接捲動,下次自動對位仍尊重使用者的視線位置 */
  adjustFollowOffset: (deltaY: number) => void
  /** content effect:重建跟讀索引(維持原 effect 順序與其餘副作用) */
  rebuildIndex: (content: string) => void
  clearActiveChunk: () => void
  /** 換稿(onOverlayLoadScript):高亮與進度一起歸零 */
  resetProgress: () => void
}

/**
 * 語音跟讀(scroll 模式限定):Whisper 本地轉錄 + chunk 對位,唸到哪、捲到哪。
 * 自 OverlayApp 抽出;effect 順序敏感的部分(rebuildIndex/resetProgress)由呼叫端
 * 在原 effect 內以函數呼叫,行為不變。
 */
export function useFollowMode(params: UseFollowModeParams): UseFollowModeResult {
  const { settings, controlsRef, scrollRef, onMeSpeech } = params

  const [followStatus, setFollowStatus] = useState<FollowStatus>('idle')
  // 給一次性 effect(onOverlayLoadScript 自動播放)讀最新值用,避免閉包捕獲 stale 'idle'
  const followStatusRef = useRef<FollowStatus>('idle')
  followStatusRef.current = followStatus
  const [followMsg, setFollowMsg] = useState('')
  const [lastHeard, setLastHeard] = useState('')
  const [activeChunk, setActiveChunk] = useState(-1)
  const [followProgress, setFollowProgress] = useState(0)

  const whisperRef = useRef<WhisperClient | null>(null)
  const segmenterRef = useRef<AudioSegmenter | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const followRef = useRef<{ chunks: FollowChunk[]; norm: string; pos: number }>({
    chunks: [],
    norm: '',
    pos: 0
  })
  const chunkElsRef = useRef<Map<number, HTMLSpanElement>>(new Map())
  // 跟隨模式的手動滾輪偏移:使用者滾動後,自動對位仍以此偏移為基準(不回彈)
  const followOffsetRef = useRef(0)
  const followLevelRef = useRef(0)
  /** 取消模型載入或麥克風授權中的啟動;晚到的 getUserMedia 必須立即停軌 */
  const startAttemptRef = useRef(0)

  // 除錯事件流:跟讀狀態轉換(idle → loading → listening / error)是追「跟讀為什麼沒動」
  // 的第一手線索,而它偏偏最難人工重現(要麥克風 + 下載模型 + 開口唸稿)。
  const lastFollowStatusRef = useRef<FollowStatus>('idle')
  useEffect(() => {
    if (lastFollowStatusRef.current === followStatus) return
    debugLog('follow', `狀態 ${lastFollowStatusRef.current} → ${followStatus}`, {
      msg: followMsg,
      lastHeard: lastHeard.slice(0, 40)
    })
    lastFollowStatusRef.current = followStatus
  }, [followStatus, followMsg, lastHeard])

  useEffect(() => {
    return () => {
      startAttemptRef.current += 1
      // 視窗關閉時清理音訊
      segmenterRef.current?.stop(false)
      segmenterRef.current = null
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      whisperRef.current?.dispose()
      whisperRef.current = null
    }
  }, [])

  const clearActiveChunk = useCallback((): void => {
    setActiveChunk(-1)
  }, [])

  const resetProgress = useCallback((): void => {
    setActiveChunk(-1)
    setFollowProgress(0)
  }, [])

  const rebuildIndex = useCallback((text: string): void => {
    followRef.current = {
      chunks: buildChunks(text),
      norm: normalizeForMatch(text),
      pos: 0
    }
  }, [])

  const scrollToChunk = useCallback((idx: number): void => {
    const el = scrollRef.current
    const target = chunkElsRef.current.get(idx)
    if (!el || !target) return
    const top = target.offsetTop - el.clientHeight * 0.33 + followOffsetRef.current
    el.scrollTo({ top: Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight)), behavior: 'smooth' })
    const maxScroll = el.scrollHeight - el.clientHeight
    if (maxScroll > 0) setFollowProgress(Math.min(1, el.scrollTop / maxScroll))
  }, [scrollRef])

  const handleFollowTranscript = useCallback(
    (text: string): void => {
      // 餵給 main 的 liveContext:panic 觸發時才有語音上下文可用
      void window.api.pushTranscript({ text, speaker: 'me' })
      // 我方開口 → 即時收掉「該你說話了」提示(你已在回話)。
      // 硬編碼中文填充詞是刻意的:STT 對極短音沒有把握,即便只聽到
      // 「嗯」也不該讓「該你了」繼續掛著——誤收一次的代價遠低於漏收。
      const isMeSpeech = text.trim().length >= 2 || /[嗯呃誒]/.test(text)
      if (isMeSpeech) onMeSpeech?.()
      const f = followRef.current
      const spoken = normalizeForMatch(text)
      if (spoken.length < 4) return
      // 兩段式:先在當前位置附近找;失敗時放寬向後視窗 — 偵測「重複唸上一段」自動跳回關鍵詞
      let end = bestMatchPosition(f.norm, spoken, f.pos)
      if (end < 0) {
        end = bestMatchPosition(f.norm, spoken, f.pos, { backward: 160 })
      }
      if (end >= 0) {
        f.pos = end
        const idx = chunkAtPosition(f.chunks, Math.max(0, end - 1))
        setActiveChunk(idx)
        scrollToChunk(idx)
        setLastHeard(text.slice(0, 60))
        debugLog('follow', `對位 chunk ${idx}`, { heard: text.slice(0, 40), pos: f.pos })
      }
    },
    [scrollToChunk, onMeSpeech]
  )

  // 跟隨中滾輪微調:調整偏移而非直接捲動,下次自動對位仍尊重使用者的視線位置
  const adjustFollowOffset = useCallback(
    (deltaY: number): void => {
      if (followStatus !== 'listening') return
      followOffsetRef.current = Math.max(-3000, Math.min(3000, followOffsetRef.current + deltaY))
    },
    [followStatus]
  )

  const startFollow = useCallback(async (): Promise<void> => {
    if (!settings || followStatusRef.current === 'loading' || followStatusRef.current === 'listening') return
    const attempt = ++startAttemptRef.current
    const isCurrentAttempt = (): boolean => attempt === startAttemptRef.current
    // 跟讀時暫停自動捲動,讓位給語音對齊
    controlsRef.current?.pause()
    followOffsetRef.current = 0
    setFollowMsg('')
    followStatusRef.current = 'loading'
    setFollowStatus('loading')
    let stream: MediaStream | null = null
    let segmenter: AudioSegmenter | null = null
    try {
      if (!whisperRef.current) whisperRef.current = new WhisperClient()
      const client = whisperRef.current
      client.onProgress = (p) => {
        if (isCurrentAttempt() && p.status === 'progress') setFollowMsg(`載入模型 ${p.progress?.toFixed(0) ?? 0}%`)
      }
      client.onStatus = (m) => {
        if (isCurrentAttempt()) setFollowMsg(m)
      }
      await client.load((settings.stt.localModel ?? 'base') as WhisperModelKey)
      if (!isCurrentAttempt()) return

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      if (!isCurrentAttempt()) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      segmenter = new AudioSegmenter({
        // sr 不需要:transcribe 只需要 PCM 資料本身,取樣率由 whisperClient 從
// audio 的長度推回。帶著它只是把一個用不到的參數帶進閉包。
        onSegment: (audio) => {
          void client
            .transcribe(audio, settings.stt.language)
            .then((text) => {
              if (isCurrentAttempt()) handleFollowTranscript(text)
            })
            .catch(() => undefined)
        },
        onLevel: (r) => {
          followLevelRef.current = r
        },
        threshold: 0.01
      })
      segmenterRef.current = segmenter
      await segmenter.start(stream)
      if (!isCurrentAttempt()) {
        segmenter.stop(false)
        stream.getTracks().forEach((t) => t.stop())
        if (segmenterRef.current === segmenter) segmenterRef.current = null
        if (streamRef.current === stream) streamRef.current = null
        return
      }
      followStatusRef.current = 'listening'
      setFollowStatus('listening')
      setFollowMsg('')
    } catch (err) {
      segmenter?.stop(false)
      stream?.getTracks().forEach((t) => t.stop())
      if (!isCurrentAttempt()) return
      segmenterRef.current = null
      streamRef.current = null
      followStatusRef.current = 'error'
      setFollowStatus('error')
      setFollowMsg(err instanceof Error ? err.message : String(err))
    }
  }, [settings, handleFollowTranscript, controlsRef])

  const stopFollow = useCallback((): void => {
    startAttemptRef.current += 1
    const wasLoading = followStatusRef.current === 'loading'
    segmenterRef.current?.stop()
    segmenterRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    // 使用者在模型下載/初始化中取消時中止 worker,避免背景繼續下載大型模型。
    if (wasLoading) {
      whisperRef.current?.dispose()
      whisperRef.current = null
    }
    followOffsetRef.current = 0
    followStatusRef.current = 'idle'
    setFollowStatus('idle')
    setFollowMsg('')
    setActiveChunk(-1)
  }, [])

  const toggleFollow = useCallback((): void => {
    if (followStatus === 'idle' || followStatus === 'error') {
      void startFollow()
    } else {
      stopFollow()
    }
  }, [followStatus, startFollow, stopFollow])

  return {
    followStatus,
    followStatusRef,
    followMsg,
    lastHeard,
    activeChunk,
    followProgress,
    followChunks: followStatus === 'listening' ? followRef.current.chunks : null,
    followLevelRef,
    chunkElsRef,
    startFollow,
    stopFollow,
    toggleFollow,
    adjustFollowOffset,
    rebuildIndex,
    clearActiveChunk,
    resetProgress
  }
}
