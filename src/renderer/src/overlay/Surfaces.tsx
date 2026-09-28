import type { JSX } from 'react'
import { AlignJustify, AudioLines, List, Type } from 'lucide-react'
import type { AppSettings, OverlayDisplayMode } from '@shared/types'
import { cn } from '../lib/utils'
import type { FollowChunk } from '../lib/follow'
import { PhraseVisuals } from '../lib/teleprompter/constants'
import type { EngineState } from '../lib/teleprompter/engine'
import type { ScriptModel } from '../lib/teleprompter/scriptModel'

export const MODES: Array<{ id: OverlayDisplayMode; label: string; icon: typeof AlignJustify }> = [
  { id: 'scroll', label: '連續捲動', icon: AlignJustify },
  { id: 'phrase', label: '逐句短語', icon: Type },
  { id: 'bullet', label: '重點要點', icon: List },
  { id: 'karaoke', label: '逐詞卡拉OK', icon: AudioLines }
]

export function ToolBtn({
  onClick,
  active,
  title,
  children
}: {
  onClick: () => void
  active?: boolean
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors cursor-pointer no-drag',
        active ? 'bg-accent-500/25 text-accent-300' : 'text-white/72 hover:bg-white/10 hover:text-white'
      )}
    >
      {children}
    </button>
  )
}

// ── 模式畫面 ──

export function ScrollSurface({
  model,
  settings,
  onTogglePlay,
  scrollRef,
  followChunks,
  activeChunk,
  chunkElRef,
  onWheelAdjust
}: {
  model: ScriptModel
  settings: AppSettings['overlay']
  onTogglePlay: () => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  followChunks: FollowChunk[] | null
  activeChunk: number
  chunkElRef: (i: number, el: HTMLSpanElement | null) => void
  onWheelAdjust: (deltaY: number) => void
}): JSX.Element {
  return (
    <div
      ref={scrollRef}
      className="h-full cursor-pointer overflow-y-auto px-7 py-5"
      style={{ scrollbarWidth: 'none' }}
      onClick={followChunks ? undefined : onTogglePlay}
      onWheel={(e) => onWheelAdjust(e.deltaY)}
    >
      <div
        className="font-medium text-white/100 select-none"
        style={{
          fontSize: settings.fontSize,
          lineHeight: settings.lineHeight,
          textShadow: '0 1px 6px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)',
          letterSpacing: '0.02em'
        }}
      >
        {followChunks
          ? followChunks.map((chunk, i) => {
              const isActive = i === activeChunk
              const isRead = activeChunk >= 0 && i < activeChunk
              return (
                <span
                  key={i}
                  ref={(el) => chunkElRef(i, el)}
                  className={cn(
                    'transition-colors duration-300',
                    isActive && 'rounded bg-accent-500/35',
                    isRead && 'text-white/45'
                  )}
                >
                  {chunk.text}
                  {'\n'}
                </span>
              )
            })
          : model.content}
      </div>
      <div className="h-[40vh]" />
    </div>
  )
}

export function PhraseSurface({
  model,
  state,
  fontSize
}: {
  model: ScriptModel
  state: EngineState
  fontSize: number
}): JSX.Element {
  const phrases = model.phrases[state.sentenceIndex] ?? []
  const nextSentence = model.sentences[state.sentenceIndex + 1] ?? null
  // 預讀:當前步驟將在 500ms 內結束時,先亮起下一短語
  const readAhead =
    state.status === 'playing' &&
    state.stepDurationMs - state.stepElapsedMs <= PhraseVisuals.UPCOMING_PHRASE_ADVANCE_MS

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-4">
      {/* 行寬鎖 30-35 字(W3C 中文排版甜蜜點),一眼掃完不動頭 */}
      <div
        className="flex max-w-[32em] flex-wrap gap-x-3 gap-y-1 font-semibold select-none"
        style={{ fontSize, lineHeight: PhraseVisuals.LINE_HEIGHT }}
      >
        {phrases.map((p, i) => {
          const isActive = i === state.phraseIndex
          const isNext = readAhead && i === state.phraseIndex + 1
          const opacity = isActive
            ? PhraseVisuals.ACTIVE_PHRASE_OPACITY
            : isNext
              ? PhraseVisuals.UPCOMING_PHRASE_OPACITY
              : i < state.phraseIndex
                ? PhraseVisuals.PREV_LINE_OPACITY
                : PhraseVisuals.NEXT_LINE_OPACITY
          return (
            <span
              key={i}
              className="transition-opacity duration-150"
              style={{
                opacity,
                color: isActive ? '#fff' : isNext ? 'var(--color-accent-300)' : undefined,
                textShadow: '0 1px 3px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.5)'
              }}
            >
              {p.text}
            </span>
          )
        })}
      </div>
      {nextSentence && (
        <div
          className="mt-3 truncate border-t border-white/5 pt-2 text-white/52 select-none"
          style={{ fontSize: Math.max(14, fontSize * 0.55) }}
        >
          下一句:{nextSentence}
        </div>
      )}
    </div>
  )
}

export function BulletSurface({
  model,
  state,
  fontSize
}: {
  model: ScriptModel
  state: EngineState
  fontSize: number
}): JSX.Element {
  const bullet = model.bullets[state.bulletIndex]

  if (!bullet) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-white/52 select-none">
        此講稿無法切出重點
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-4 select-none">
      <div
        className="font-semibold text-white"
        style={{ fontSize: fontSize * 1.05, lineHeight: 1.35, textShadow: '0 1px 6px rgba(0,0,0,0.85)' }}
      >
        {bullet.title}
      </div>
      {bullet.subPoints.length > 0 && (
        <ul className="mt-2 space-y-1 text-white/72" style={{ fontSize: Math.max(14, fontSize * 0.58) }}>
          {bullet.subPoints.map((sp, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-accent-400">•</span>
              <span>{sp}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 font-mono text-[10px] text-white/52">
        {state.bulletIndex + 1} / {model.bullets.length} ・ ← → 切換
      </div>
    </div>
  )
}

/**
 * 貼鏡模式表面(v3 TeleprompterGazeSurface 的幾何錨定 lite 版):
 * 當前行鎖定在鏡頭下方 ~2° 視角的 camera band,下面依 0.62/0.38 淡出預讀。
 * 文字距鏡頭 <5cm 時眼球偏轉角極小,錄出來就像直視鏡頭。
 */
export function LensSurface({
  model,
  state,
  displayMode
}: {
  model: ScriptModel
  state: EngineState
  displayMode: OverlayDisplayMode
}): JSX.Element {
  if (displayMode === 'bullet') {
    const bullet = model.bullets[state.bulletIndex]
    const next = model.bullets[state.bulletIndex + 1]
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-1.5 select-none">
        <div className="font-semibold leading-snug text-white/72 reading-shadow" style={{ fontSize: 19 }}>
          {bullet?.title ?? '—'}
        </div>
        {bullet && bullet.subPoints.length > 0 && (
          <div className="mt-0.5 truncate text-[11px] text-white/72" style={{ opacity: 0.8 }}>
            {bullet.subPoints[0]}
          </div>
        )}
        <div className="mt-auto truncate pb-1.5 text-[11px] text-white/72" style={{ opacity: 0.62 }}>
          下一點:{next?.title ?? '(結束)'}
        </div>
      </div>
    )
  }

  if (displayMode === 'karaoke') {
    const words = model.karaokeWordChunks[state.karaokeChunkIndex] ?? []
    const nextChunk = model.karaokeChunks[state.karaokeChunkIndex + 1]
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-1.5 select-none">
        <div className="flex flex-wrap gap-x-1.5 font-semibold leading-snug reading-shadow" style={{ fontSize: 19 }}>
          {words.map((w, i) => (
            <span
              key={i}
              style={{
                color:
                  i === state.karaokeWordIndex
                    ? '#fff'
                    : i < state.karaokeWordIndex
                      ? 'var(--color-accent-300)'
                      : 'var(--color-ink-400)'
              }}
            >
              {w}
            </span>
          ))}
        </div>
        <div className="mt-auto truncate pb-1.5 text-[11px] text-white/72" style={{ opacity: 0.62 }}>
          下一詞組:{nextChunk ?? '(結束)'}
        </div>
      </div>
    )
  }

  // phrase / scroll:句子 band + 短語高亮
  const phrases = model.phrases[state.sentenceIndex] ?? []
  const nextSentence = model.sentences[state.sentenceIndex + 1] ?? null
  const upcoming = model.sentences[state.sentenceIndex + 2] ?? null
  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pt-1.5 select-none">
      <div className="flex flex-wrap gap-x-2 font-medium leading-snug reading-shadow" style={{ fontSize: 19 }}>
        {phrases.map((p, i) => (
          <span
            key={i}
            style={{
              color: i === state.phraseIndex ? '#fff' : undefined,
              opacity:
                i === state.phraseIndex
                  ? 1
                  : i === state.phraseIndex + 1
                    ? 0.62
                    : i < state.phraseIndex
                      ? 0.22
                      : 0.38
            }}
          >
            {p.text}
          </span>
        ))}
      </div>
      <div className="mt-auto space-y-0.5 pb-1.5">
        <div className="truncate text-[12px] text-white/72" style={{ opacity: 0.62 }}>
          下一句:{nextSentence ?? '—'}
        </div>
        {upcoming && (
          <div className="truncate text-[11px] text-white/72" style={{ opacity: 0.38 }}>
            再下一句:{upcoming}
          </div>
        )}
      </div>
    </div>
  )
}

export function KaraokeSurface({
  model,
  state,
  fontSize
}: {
  model: ScriptModel
  state: EngineState
  fontSize: number
}): JSX.Element {
  const words = model.karaokeWordChunks[state.karaokeChunkIndex] ?? []
  const totalChunks = model.karaokeChunks.length

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-4 select-none">
      <div
        className="flex flex-wrap gap-x-2 gap-y-0.5 font-semibold"
        style={{ fontSize, lineHeight: PhraseVisuals.LINE_HEIGHT }}
      >
        {words.map((w, i) => {
          const done = i < state.karaokeWordIndex
          const active = i === state.karaokeWordIndex
          return (
            <span
              key={i}
              className="transition-colors duration-100"
              style={{
                color: active ? '#fff' : done ? 'var(--color-accent-300)' : 'var(--color-ink-600)',
                textShadow: active
                  ? '0 0 12px rgba(143,140,250,0.55), 0 1px 6px rgba(0,0,0,0.85)'
                  : undefined
              }}
            >
              {w}
            </span>
          )
        })}
      </div>
      <div className="mt-2 font-mono text-[10px] text-white/52">
        {Math.min(state.karaokeChunkIndex + 1, totalChunks)} / {totalChunks}
      </div>
    </div>
  )
}
