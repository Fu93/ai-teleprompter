import type { JSX } from 'react'
import { AlignJustify, AudioLines, List, Type } from 'lucide-react'
import type { AppSettings, OverlayDisplayMode } from '@shared/types'
import { cn } from '../lib/utils'
import type { FollowChunk } from '../lib/follow'
import { PhraseVisuals } from '../lib/teleprompter/constants'
import type { EngineState } from '../lib/teleprompter/engine'
import type { ScriptModel } from '../lib/teleprompter/scriptModel'
import { tokenGapAt } from '../lib/teleprompter/modeTransforms'

export const MODES: Array<{ id: OverlayDisplayMode; label: string; icon: typeof AlignJustify }> = [
  { id: 'scroll', label: '連續捲動', icon: AlignJustify },
  { id: 'phrase', label: '逐句短語', icon: Type },
  { id: 'bullet', label: '重點要點', icon: List },
  { id: 'karaoke', label: '逐詞卡拉OK', icon: AudioLines }
]

/**
 * ToolBtn — 浮層工具列的圖示按鈕。
 *
 * ── 為什麼說明不再只靠 title ──
 *   改動前這裡的唯一說明就是原生 tooltip:
 *   要 hover 約一秒才出現、內容是一整句(貼鏡那顆 40 字),而工具列本身是
 *   可橫捲的容器 —— 說明還沒出現,捲動位置已經把按鈕帶走了。更糟的是
 *   `title` 會與展開面板的說明列同時出現,使用者在兩個地方讀到同一句話。
 *   現在說明由**底欄說明列**負責(見 OverlayApp 的 toolbarHint):游標或鍵盤
 *   焦點落在哪一顆,底欄就報哪一顆,而底欄是既有的一列、不被裁切、不佔寬度。
 *   兩個一起留著:**說明列**給「一眼知道這顆是什麼」,title 給「停久一點看完整
 *   說明」;兩者的關係見下面 title 那一行的註解。
 *
 * ── 為什麼名稱仍然只有 title(不另外寫 aria-label)──
 *   這是純圖示按鈕(可見文字是空的),而它需要一個可及名稱 —— title 就是。
 *   瀏覽器把 title 當成 accessible name 的來源,而專案自己的
 *   `no-accessible-name` 規則也把它算成合格名稱(改動前就是這樣全綠的,
 *   不是這一輪要動的東西)。
 *
 *   ⚠️ 不要「順手」補一個 `aria-label={title}`:那看起來更保險,實際上會
 *   悄悄改掉**每一顆工具的覆蓋率身分**。列舉端(effect-inventory 的
 *   ENUMERATE)對名稱的規則是 text → aria-label → title,而且只對 title 做
 *   收斂(在第一個括號/冒號處切斷,因為那是作者寫補充說明的地方)。
 *   aria-label 一旦與 title 並存,身分就從收斂後的「暫停」變成整句的
 *   「暫停(空白鍵)」—— 登記表裡 20 幾筆 key 當場對不上,報告會同時出現
 *   probe-not-found(登記的鈕「從沒出現過」)與 no-effect-probe(畫面上的
 *   「新」鈕沒人登記)。兩個都是假紅燈,而原因只是一行看起來更無障礙的屬性。
 *
 * ── 兩個 data 屬性 ──
 *   說明列由工具列容器以事件委派讀取(見 OverlayApp)。20 顆按鈕各自接一個
 *   onHover 會讓每個呼叫端都要記得傳,而「忘了傳」的症狀是「某一顆永遠不
 *   解釋自己」—— 那種缺陷沒有人會發現。委派 + 屬性讓「有沒有接上」變成
 *   資料上可檢查的事(audit-deep 的浮層工具列規則就是查這兩個屬性)。
 */
/**
 * Divider — 工具列的分組分隔線。
 *
 * 20 顆純圖示按鈕排成一條,沒有分隔時「哪幾顆屬於同一組」只能靠使用者自己猜
 * —— 而這正是上一輪「展開面板看不懂」的一部分:它是一條沒有段落的長句子。
 * 分組用最窄的可見形式:1px 豎線 + 各 2px 邊距(合計 5px)。四條 = 20px,
 * 換來「四組各 2–7 顆」的結構;那筆寬度花得比再多一顆按鈕值得。
 */
export function Divider(): JSX.Element {
  return <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-white/12" />
}

export function ToolBtn({
  onClick,
  active,
  title,
  label,
  children
}: {
  onClick: () => void
  active?: boolean
  /** 完整說明(一句話)。指向 aria-label 與說明列的第二行。 */
  title: string
  /**
   * 說明列上的短標籤(2–4 字,例如「播放」「貼鏡」「穿透」)。
   * 沒給就退回 title —— 但 title 是一整句,底欄放不下也不好看,
   * 所以工具列上的每一顆都應該給。
   */
  label?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      // title **必須留著**,即使說明列已經有短標籤。三個理由,每一個都是實測的:
      //   1. 六支稽核(deep / effects / glass-edge)與 probe-* 都用 title 找浮層
      //      上的控制項(例如 `title === '收合成藥丸(低存在感)'`)。拿掉 title
      //      會讓它們回報「找不到控制項」—— 那是**工具壞了**,不是 UI 壞了。
      //   2. e2e 也一樣:`[title^="暫停"]`、`[title*="收合成藥丸"]` 之類的定位器
      //      散在 pill-progress / pill-notice / blindspot / playtest3 等 spec。
      //   3. 貼鏡模式的四顆沒有說明列(那裡的視窗只有 170px 高),title 是它們
      //      唯一的長說明。
      // 說明列負責的是「一眼知道這顆是什麼」,title 負責的是「游標停久一點看完整
      // 說明」;兩者不衝突,而取消 title 的代價是六處工具同時壞掉。
      title={title}
      data-tooltip-label={label ?? title}
      data-tooltip-detail={title}
      // 「這一顆有短標籤」的明確記號。說明列的覆蓋率規則要能分辨「給了短標籤」
      // 與「退回整句 title」—— 否則那條規則永遠是綠的(前者才是要的狀態)。
      data-tooltip-short={label ? '1' : undefined}
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
  displayMode,
  suppressBottom
}: {
  model: ScriptModel
  state: EngineState
  displayMode: OverlayDisplayMode
  /** 貼鏡提示(lensHint)顯示的 6 秒內收起底部預讀行 —— 提示與預讀是絕對定位
   *  的同一段高度,疊印在一起兩行都讀不了(提示是暫態,預讀下一輪還會回來)。 */
  suppressBottom?: boolean
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
        {!suppressBottom && (
          <div className="mt-auto truncate pb-1.5 text-[11px] text-white/72" style={{ opacity: 0.62 }}>
            下一點:{next?.title ?? '(結束)'}
          </div>
        )}
      </div>
    )
  }

  if (displayMode === 'karaoke') {
    const words = model.karaokeWordChunks[state.karaokeChunkIndex] ?? []
    const spacing = model.karaokeTokenSpacing[state.karaokeChunkIndex]
    const nextChunk = model.karaokeChunks[state.karaokeChunkIndex + 1]
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-1.5 select-none">
        {/* 詞距只留在原文有空白的邊界:逐字切出來的中文字序列若套 gap,
            字與字之間會被拉開 6px,整行讀起來像被拆散。 */}
        <div className="flex flex-wrap font-semibold leading-snug reading-shadow" style={{ fontSize: 19 }}>
          {words.map((w, i) => (
            <span
              key={i}
              className={tokenGapAt(spacing, i + 1) ? 'mr-1.5' : undefined}
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
        {!suppressBottom && (
          <div className="mt-auto truncate pb-1.5 text-[11px] text-white/72" style={{ opacity: 0.62 }}>
            下一詞組:{nextChunk ?? '(結束)'}
          </div>
        )}
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
      {!suppressBottom && (
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
      )}
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
  const spacing = model.karaokeTokenSpacing[state.karaokeChunkIndex]
  const totalChunks = model.karaokeChunks.length

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center px-7 py-4 select-none">
      {/* 同 LensSurface:詞距只留在原文有空白的邊界(見 karaokeTokenSpacing) */}
      <div
        className="flex flex-wrap gap-y-0.5 font-semibold"
        style={{ fontSize, lineHeight: PhraseVisuals.LINE_HEIGHT }}
      >
        {words.map((w, i) => {
          const done = i < state.karaokeWordIndex
          const active = i === state.karaokeWordIndex
          return (
            <span
              key={i}
              className={cn('transition-colors duration-100', tokenGapAt(spacing, i + 1) && 'mr-2')}
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
