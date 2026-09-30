/**
 * DebugHud.tsx — 浮層視窗的開發者除錯層(UI/UX debug 支援)。
 *
 * 為什麼浮層要單獨一套:
 *   浮層是 frameless、透明、置頂、可能滑鼠穿透、預設還開著「螢幕擷取隱形」的
 *   獨立視窗。它沒有選單、沒有右鍵、沒有 <aside> 可辨識,連離線稽核腳本都是
 *   到很後期才開始檢查它。出問題時唯一的手段是「改 CSS → 重建 → 再猜」。
 *
 * 兩條與主視窗不同的設計:
 *   1. 狀態快照以 window.__debugSnapshot 暴露,由 main 端 executeJavaScript 取回。
 *      比讓浮層定期 IPC 廣播便宜,也不必維護第二條常駐通道。
 *   2. 除錯控制 window.__debugControl 是「點浮層自己的按鈕」而不是直接改 state ——
 *      形態切換(compact/lens)會連帶改變視窗尺寸與 morph 動畫,直接改設定只會
 *      翻旗標,留下「藥丸的內容裝在展開的視窗裡」。走 UI 才是真實路徑,
 *      這條路徑也正是稽核腳本踩過坑後學到的教訓。
 *
 * 渲染走 portal 掛到 body:浮層的根容器是高度敏感的 flex 版面(貼鏡模式只有
 * 170px,任何多出來的層都會把正文擠掉),除錯層不能參與那個版面計算。
 */
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DebugOverlayAction, DomFinding } from '@shared/types'
import { domAudit } from '../lib/domAudit'
import { cn, formatDuration } from '../lib/utils'
import { useDebug } from '../lib/debug'
import { LayoutDebugLayer } from '../components/LayoutDebugLayer'

export interface OverlayDebugData {
  mode: string
  compact: boolean
  lens: boolean
  mirror: boolean
  opacity: number
  fontSize: number
  status: string
  sentenceIndex: number
  phraseIndex: number
  karaokeChunkIndex: number
  bulletIndex: number
  elapsedMs: number
  scrollPos: number
  rate: number
  effectiveRate: number
  followStatus: string
  followChunk: number
  followProgress: number
  lastHeard: string
  glass: boolean
  refractOk: boolean
  captureProtected: boolean
  clickThrough: boolean
  alwaysOnTop: boolean
  contentLen: number
  sentences: number
  phrases: number
  bullets: number
}

declare global {
  interface Window {
    /** main 端 debug:overlay-snapshot 取用 */
    __debugSnapshot?: () => unknown
    /** main 端 debug:overlay-call 取用 */
    __debugControl?: (action: string) => boolean
    /** main 端 debug:overlay-audit 取用(除錯面板的「稽核」分頁) */
    __debugAudit?: () => DomFinding[]
  }
}

/** 動作 → 浮層控制項 title 的片段(走真實 UI,不直接改 state) */
const ACTION_TITLES: Record<Exclude<DebugOverlayAction, 'recenter'>, { include: string; exclude?: string }> = {
  compact: { include: '收合成藥丸' },
  expand: { include: '展開完整面板' },
  // '貼鏡模式' 同時出現在進入與退出的 title,必須排除『退出』才不會在貼鏡模式裡按到退出
  lens: { include: '貼鏡模式', exclude: '退出' },
  'exit-lens': { include: '退出貼鏡模式' },
  play: { include: '播放' },
  pause: { include: '暫停' },
  follow: { include: '語音跟讀' }
}

function clickByTitle(include: string, exclude?: string): boolean {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => {
    const t = b.getAttribute('title') || ''
    return t.includes(include) && (!exclude || !t.includes(exclude))
  })
  if (!btn) return false
  btn.click()
  return true
}

/**
 * 視窗尺寸一律即時讀,不從 props 帶進來。
 * 浮層的尺寸是使用者拖曳/形態切換即時改變的,而 render 不一定會跟著 resize 重跑
 * (引擎暫停時尤其明顯)—— 快照若沿用 render 當下的值,量到的會是舊尺寸,
 * 而尺寸正是這個專案最常查的東西。
 */
function liveWin(): { w: number; h: number; dpr: number } {
  return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex gap-2 text-[10px] leading-relaxed">
      <span className="w-[70px] shrink-0 text-ink-400">{k}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-ink-100">{v}</span>
    </div>
  )
}

/**
 * 掛在浮層根層。未啟用時回傳 null —— 不進 DOM、不監聽、不輪詢。
 */
export function OverlayDebugRoot({ data }: { data: OverlayDebugData }): JSX.Element | null {
  const enabled = useDebug((s) => s.enabled)
  const layout = useDebug((s) => s.layout)
  const toggleLayout = useDebug((s) => s.toggleLayout)
  const [hudOpen, setHudOpen] = useState(false)

  // 每次 render 更新資料,但只安裝一次取用函式:main 隨時呼叫都拿到最新值
  const dataRef = useRef(data)
  dataRef.current = data

  useEffect(() => {
    let alive = true
    void window.api
      .appInfo()
      .then((info) => {
        if (alive) useDebug.getState().setEnabled(info.debug)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    window.__debugSnapshot = (): unknown => {
      const d = dataRef.current
      return {
        mode: d.mode,
        status: d.status,
        sentenceIndex: d.sentenceIndex,
        phraseIndex: d.phraseIndex,
        karaokeChunkIndex: d.karaokeChunkIndex,
        bulletIndex: d.bulletIndex,
        elapsedMs: Math.round(d.elapsedMs),
        scrollPos: Math.round(d.scrollPos),
        compact: d.compact,
        lens: d.lens,
        mirror: d.mirror,
        opacity: d.opacity,
        fontSize: d.fontSize,
        rate: d.rate,
        effectiveRate: Number(d.effectiveRate.toFixed(3)),
        follow: {
          status: d.followStatus,
          activeChunk: d.followChunk,
          progress: Number(d.followProgress.toFixed(3)),
          lastHeard: d.lastHeard
        },
        glass: d.glass,
        refractOk: d.refractOk,
        captureProtected: d.captureProtected,
        clickThrough: d.clickThrough,
        alwaysOnTop: d.alwaysOnTop,
        contentLen: d.contentLen,
        model: { sentences: d.sentences, phrases: d.phrases, bullets: d.bullets },
        win: liveWin()
      }
    }
    window.__debugControl = (action: string): boolean => {
      const spec = ACTION_TITLES[action as keyof typeof ACTION_TITLES]
      if (!spec) return false
      return clickByTitle(spec.include, spec.exclude)
    }
    // 同一個 domAudit 在這個視窗裡跑。主視窗的面板透過
    // debugOverlayAudit(IPC → executeJavaScript)呼叫它,離線稽核在
    // 浮層上呼叫的是同一支函式 —— 兩邊不可能給出不同的結論。
    window.__debugAudit = (): DomFinding[] => domAudit()
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'd') return
      e.preventDefault()
      setHudOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      delete window.__debugSnapshot
      delete window.__debugControl
      delete window.__debugAudit
    }
  }, [enabled])

  if (!enabled) return null

  const win = liveWin()

  return createPortal(
    <>
      <LayoutDebugLayer />
      {hudOpen && (
        <div
          id="debug-hud"
          className="fixed left-1.5 top-1.5 z-[2147483000] max-h-[92vh] w-[330px] overflow-y-auto rounded-lg border border-white/15 bg-black/88 p-2.5 text-ink-100 shadow-2xl"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="mb-1.5 flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
            <span className="text-[11px] font-semibold">OVERLAY DEBUG</span>
            <span className="min-w-0 flex-1" />
            <button
              onClick={() => setHudOpen(false)}
              title="關閉除錯 HUD"
              className="cursor-pointer rounded px-1.5 text-[11px] text-ink-300 hover:bg-white/10 hover:text-white"
            >
              關閉
            </button>
          </div>

          <Row k="視窗" v={`${win.w}×${win.h} @${win.dpr}x`} />
          <Row k="形態" v={`${data.compact ? '藥丸' : data.lens ? '貼鏡' : '展開'} · ${data.mode}${data.mirror ? ' · 鏡像' : ''}`} />
          <Row
            k="引擎"
            v={`${data.status} 句${data.sentenceIndex} 短語${data.phraseIndex} 詞${data.karaokeChunkIndex} 要點${data.bulletIndex}`}
          />
          <Row k="時間" v={`${formatDuration(data.elapsedMs / 1000)} · scroll ${Math.round(data.scrollPos)}`} />
          <Row k="倍率" v={`${data.rate}× → ${data.effectiveRate.toFixed(2)}×`} />
          <Row
            k="跟讀"
            v={`${data.followStatus} · chunk ${data.followChunk} · ${(data.followProgress * 100).toFixed(0)}%`}
          />
          <Row k="聽到" v={data.lastHeard || '—'} />
          <Row k="材質" v={`glass=${data.glass} 折射=${data.refractOk} 透明=${data.opacity}`} />
          <Row
            k="視窗層"
            v={`擷取保護=${data.captureProtected} 穿透=${data.clickThrough} 置頂=${data.alwaysOnTop}`}
          />
          <Row k="講稿" v={`${data.contentLen} 字 · 句${data.sentences} 要點${data.bullets}`} />

          {/* 浮層截圖/像素量測的前提:開了防擷取只會拍到背景 —— 稽核腳本踩過同一個坑 */}
          {data.captureProtected && (
            <button
              onClick={() => void window.api.overlaySetCaptureProtection(false)}
              className="mt-1.5 w-full cursor-pointer rounded-md border border-amber-450/40 bg-amber-450/15 px-2 py-1 text-[10px] text-amber-450"
            >
              擷取保護開啟中:截圖只會拍到背景,點此關閉
            </button>
          )}

          <div className="mt-2 flex flex-wrap gap-1">
            {(['outline', 'hits', 'overflow', 'pick'] as const).map((k) => (
              <button
                key={k}
                onClick={() => toggleLayout(k)}
                className={cn(
                  'cursor-pointer rounded border px-1.5 py-0.5 text-[10px]',
                  layout[k]
                    ? 'border-accent-400/50 bg-accent-500/25 text-accent-300'
                    : 'border-white/15 bg-white/8 text-ink-200'
                )}
              >
                {k}
              </button>
            ))}
            <button
              onClick={() => void window.api.overlayHide()}
              className="cursor-pointer rounded border border-white/15 bg-white/8 px-1.5 py-0.5 text-[10px] text-ink-200"
            >
              隱藏浮層
            </button>
          </div>
          <div className="mt-1.5 text-[10px] leading-relaxed text-ink-400">
            Ctrl+Shift+D 開關。狀態快照供主視窗面板讀取。
          </div>
        </div>
      )}
    </>,
    document.body
  )
}
