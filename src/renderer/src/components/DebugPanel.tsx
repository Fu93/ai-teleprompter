/**
 * DebugPanel.tsx — 主視窗的開發者除錯面板(UI/UX debug 支援)。
 *
 * 為什麼不是「開 DevTools 就好」:
 *   DevTools 看得到 DOM 與 console,但看不到這個 App 的語意狀態 —— 引擎在第幾句、
 *   跟讀對位到哪個 chunk、校準後的 1× 實際換算成多少倍率、浮層現在是藥丸還是貼鏡、
 *   教練訊號有沒有進來。而這些正是實際會壞的地方。面板把「量測」與「重現」放在
 *   同一個地方:看得到狀態,也能假造事件把難重現的 UI 叫出來。
 *
 * 為什麼事件流要能暫停:
 *   事件在捲動時會一直跳,要停下來細看某一筆 payload 就得能凍結。
 *
 * 啟用:見 src/main/debug.ts。預設關閉,Ctrl+Shift+D 開關;未啟用時整個元件
 * 回傳 null(不進 DOM、不監聽、不訂閱)。
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppInfo, CoachingKind, DebugOverlayAction, DebugSignalKind, DomFinding } from '@shared/types'
import type { DebugOverlayInfo } from '@shared/api'
import { cn, formatDuration } from '../lib/utils'
import { toast } from '../lib/toast'
import { useSettings } from '../lib/store'
import {
  buildDiagnostics,
  debugLog,
  LAYOUT_DEBUG_KEYS,
  LAYOUT_DEBUG_LABEL,
  subscribeDebugSignals,
  useDebug
} from '../lib/debug'
import { LayoutDebugLayer } from './LayoutDebugLayer'
import { domAudit } from '../lib/domAudit'
import { useEscape } from '../lib/useEscape'
import { effectiveEngineRate } from '../lib/calibration'
import { PhraseVisuals } from '../lib/teleprompter/constants'

/** 面板預設寬度;拖曳邊界用 */
const PANEL_W = 404

/** 範例稿:與 scripts/capture-ui.mjs 同一份,讓截圖與手動除錯看到的內容一致 */
const DEMO_SCRIPT = `各位好,今天要向大家介紹我們的新產品 Flow。
首先,為什麼我們要做這件事?因為每場重要對話,你都只有一次機會。
接下來三個重點:第一,市場痛點;第二,我們的解法;第三,為什麼是現在。
市場痛點很簡單——資訊不對等。會議中你可能在想上一句話,就已經錯過下一句。
我們的解決方案是即時的語意追蹤與提示,像副駕駛一樣安靜地幫你補位。
為什麼是現在?因為本地語音模型剛好跨越了延遲的門檻。
總結一句話:我們不是取代你的注意力,而是保護它。
謝謝大家,接下來是實機示範。`

type Tab = 'state' | 'layout' | 'audit' | 'events' | 'actions'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'state', label: '狀態' },
  { id: 'layout', label: '版面' },
  { id: 'audit', label: '稽核' },
  { id: 'events', label: '事件' },
  { id: 'actions', label: '動作' }
]

/** 面板根:負責 gate、快捷鍵、事件訂閱與版面層掛載 */
export function DebugRoot(): JSX.Element | null {
  const enabled = useDebug((s) => s.enabled)
  const [app, setApp] = useState<AppInfo | null>(null)

  // 能力是否啟用由 main 決定(它才知道 isPackaged 與 AI_TP_* 環境變數)
  useEffect(() => {
    let alive = true
    void window.api
      .appInfo()
      .then((info) => {
        if (!alive) return
        setApp(info)
        useDebug.getState().setEnabled(info.debug)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    debugLog('debug', `除錯層啟動 v${app?.version ?? '?'}`, { userDataPath: app?.userDataPath })
    const offSignals = subscribeDebugSignals()
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'd') return
      e.preventDefault()
      useDebug.getState().togglePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offSignals()
      window.removeEventListener('keydown', onKey)
    }
  }, [enabled, app])

  if (!enabled) return null
  return (
    <>
      <LayoutDebugLayer />
      <DebugPanel app={app} />
    </>
  )
}

/**
 * 浮層的狀態快照(main 端以 executeJavaScript 取回)。
 * 只在對應頁籤可見時輪詢:除錯工具不該在背景一直對另一個視窗下指令。
 */
function useOverlayDebug(active: boolean): {
  info: DebugOverlayInfo | null
  snapshot: Record<string, unknown> | null
  refresh: () => Promise<void>
} {
  const [info, setInfo] = useState<DebugOverlayInfo | null>(null)
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    const [i, s] = await Promise.all([
      window.api.debugOverlayInfo().catch(() => null),
      window.api.debugOverlaySnapshot().catch(() => null)
    ])
    setInfo(i)
    setSnapshot(s)
  }, [])
  useEffect(() => {
    if (!active) return
    void refresh()
    const t = setInterval(() => void refresh(), 1000)
    return () => clearInterval(t)
  }, [active, refresh])
  return { info, snapshot, refresh }
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex gap-2 py-[3px] text-[11px] leading-relaxed">
      <span className="w-[86px] shrink-0 text-ink-400">{k}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-ink-200">{v}</span>
    </div>
  )
}

function Btn({
  children,
  onClick,
  active
}: {
  children: React.ReactNode
  onClick: () => void
  active?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded-lg border px-2 py-1 text-[11px] transition-colors',
        active
          ? 'border-accent-400/50 bg-accent-500/20 text-accent-300'
          : 'border-white/12 bg-white/5 text-ink-200 hover:bg-white/10'
      )}
    >
      {children}
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-3">
      <div className="eyebrow mb-1.5">{title}</div>
      {children}
    </div>
  )
}

/**
 * 稽核分頁:就地跑與離線稽核同一份規則(src/renderer/src/lib/domAudit.ts)。
 *
 * 為什麼要有這個而不是只看 LayoutDebugLayer 的外框標記:
 *   外框告訴你「哪裡」有問題,但不告訴你「哪一種問題、共幾筆、哪一筆優先」。
 *   而且離線稽核跑一次要 `npm run build` + 啟動 Electron + 播種資料,
 *   修一行想看結果也得等幾分鐘 —— 於是就不看了。這裡是「立刻」。
 *
 * 浮層要走 IPC(executeJavaScript):另一個視窗有自己的 document。
 */
function AuditTab({ onShowLayout }: { onShowLayout: (k: 'hits' | 'overflow') => void }): JSX.Element {
  const [mine, setMine] = useState<DomFinding[] | null>(null)
  const [theirs, setTheirs] = useState<DomFinding[] | null>(null)
  const [busy, setBusy] = useState(false)

  const runBoth = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setMine(domAudit())
      setTheirs(await window.api.debugOverlayAudit().catch(() => null))
    } finally {
      setBusy(false)
    }
  }, [])

  const groups = (list: DomFinding[] | null): Array<[string, DomFinding[]]> => {
    if (!list) return []
    const m = new Map<string, DomFinding[]>()
    for (const f of list) {
      const arr = m.get(f.kind) ?? []
      arr.push(f)
      m.set(f.kind, arr)
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }

  const copyReport = (): void => {
    void navigator.clipboard
      ?.writeText(JSON.stringify({ window: mine, overlay: theirs }, null, 2))
      .then(() => toast.success('稽核結果已複製'))
      .catch(() => toast.error('複製失敗'))
  }

  const renderGroup = (list: DomFinding[] | null): JSX.Element => {
    if (list === null) return <div className="text-[11px] text-ink-400">尚未執行</div>
    if (list.length === 0) return <div className="text-[11px] text-emerald-400">沒有發現問題</div>
    const g = groups(list)
    return (
      <div className="space-y-2">
        <div className="text-[11px] text-ink-300">共 {list.length} 筆</div>
        {g.map(([kind, items]) => (
          <div key={kind}>
            <div className="font-mono text-[10px] text-amber-300">
              {kind} × {items.length}
            </div>
            <div className="mt-0.5 space-y-0.5">
              {items.slice(0, 12).map((f, i) => (
                <div key={i} className="break-all font-mono text-[10px] leading-relaxed text-ink-300">
                  {f.text}
                </div>
              ))}
              {items.length > 12 && (
                <div className="text-[10px] text-ink-400">…還有 {items.length - 12} 筆</div>
              )}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <>
      <Section title="規則">
        <div className="text-[11px] leading-relaxed text-ink-300">
          與 <span className="font-mono">npm run audit:ui</span> /{' '}
          <span className="font-mono">audit:deep</span> 共用同一份規則(對比、命中區、裁切、
          截斷、無障礙名稱、被覆蓋、動畫未收斂、橫向溢出、字級下限)。這裡看到什麼,
          離線稽核就會看到什麼。
        </div>
      </Section>

      <Section title="執行">
        <div className="flex flex-wrap gap-1.5">
          <Btn onClick={() => void runBoth()}>{busy ? '稽核中…' : '稽核兩個視窗'}</Btn>
          <Btn onClick={copyReport}>複製 JSON</Btn>
          <Btn onClick={() => onShowLayout('hits')}>在版面上標出命中區</Btn>
          <Btn onClick={() => onShowLayout('overflow')}>在版面上標出裁切</Btn>
        </div>
        <div className="mt-2 text-[10px] leading-relaxed text-ink-400">
          稽核結果只有種類與描述,沒有元素座標 —— 要知道是哪一個元素,用上面兩顆切到
          「版面」的標記,或開游標檢視器。
        </div>
      </Section>

      <Section title="主視窗">{renderGroup(mine)}</Section>
      <Section title="浮層">{renderGroup(theirs)}</Section>
    </>
  )
}

function DebugPanel({ app }: { app: AppInfo | null }): JSX.Element | null {
  const open = useDebug((s) => s.panelOpen)
  const layout = useDebug((s) => s.layout)
  const toggleLayout = useDebug((s) => s.toggleLayout)
  const events = useDebug((s) => s.events)
  const paused = useDebug((s) => s.paused)
  const settings = useSettings((s) => s.settings)
  const [tab, setTab] = useState<Tab>('state')
  const [pos, setPos] = useState(() => ({ x: Math.max(12, window.innerWidth - PANEL_W - 16), y: 60 }))
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const eventListRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Esc 關閉面板。與其他浮層一致(救援卡、檢視器、確認對話框都是 Esc 退出)。
  useEscape(() => useDebug.getState().togglePanel(), open)

  /**
   * 焦點管理:開啟時把焦點移進面板,關閉後還原到原本的位置。
   * 少了這一段,Ctrl+Shift+D 之後焦點還在頁面上,鍵盤使用者得 Tab 過整個 App
   * 才進得到面板;關掉之後焦點掉回 body,又要從頭來一次。
   */
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement
    const t = requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      cancelAnimationFrame(t)
      if (prev instanceof HTMLElement && document.contains(prev)) prev.focus()
    }
  }, [open])

  const { info: overlayInfo, snapshot, refresh } = useOverlayDebug(open && tab === 'state')

  // 新事件自動捲到底;暫停時不捲,否則使用者看不到自己停在那一筆
  useEffect(() => {
    const el = eventListRef.current
    if (!el || paused) return
    el.scrollTop = el.scrollHeight
  }, [events.length, paused])

  const personalBaseline = settings?.personal.profile?.charsPerMin
  const effRate = useMemo(
    () => effectiveEngineRate(settings?.overlay.rate ?? 1, personalBaseline, PhraseVisuals.DEFAULT_WPM),
    [settings?.overlay.rate, personalBaseline]
  )

  const info2 = overlayInfo
  const mode = typeof snapshot?.['mode'] === 'string' ? (snapshot['mode'] as string) : '?'
  const shape = snapshot
    ? snapshot['compact']
      ? '藥丸'
      : snapshot['lens']
        ? '貼鏡'
        : '展開'
    : info2
      ? info2.visible
        ? '(未取得 renderer 快照)'
        : '隱藏中'
      : '無浮層'
  const follow = snapshot?.['follow'] as { status?: string; activeChunk?: number } | undefined
  const snapWin = snapshot?.['win'] as { w: number; h: number; dpr: number } | undefined

  const copyDiagnostics = useCallback(async (): Promise<void> => {
    const text = buildDiagnostics({
      app,
      settings,
      overlayInfo,
      overlaySnapshot: snapshot,
      window: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
        hash: window.location.hash
      },
      events: useDebug.getState().events
    })
    try {
      await navigator.clipboard.writeText(text)
      toast.success('診斷資訊已複製到剪貼簿')
    } catch {
      toast.error('複製失敗,請改看 main.log(設定頁 → 疑難排解)')
    }
  }, [app, settings, overlayInfo, snapshot])

  const emit = useCallback(
    async (kind: DebugSignalKind, text?: string, coachingKind?: CoachingKind): Promise<void> => {
      const ok = await window.api.debugEmitSignal({ kind, text, coachingKind })
      // 送不出去幾乎都是浮層還沒建立;講清楚比默默沒反應好
      if (!ok) toast.error('浮層視窗尚未建立,無法注入訊號')
      else debugLog('debug', `注入訊號 ${kind}${coachingKind ? `:${coachingKind}` : ''}`)
      await refresh()
    },
    [refresh]
  )

  const call = useCallback(
    async (action: DebugOverlayAction): Promise<void> => {
      const ok = await window.api.debugOverlayCall(action)
      if (!ok) toast.error(`浮層沒有回應「${action}」`)
      debugLog('debug', `浮層控制 ${action}`, { ok })
      await refresh()
    },
    [refresh]
  )

  const patchOverlay = useCallback(
    (patch: Record<string, unknown>): void => {
      void window.api.setSettings({ overlay: patch })
      debugLog('debug', '改設定', patch)
    },
    []
  )

  if (!open) return null

  const o = settings?.overlay

  return (
    <div
      id="debug-panel"
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label="UI/UX 除錯面板"
      className="glass fixed z-[70] flex flex-col rounded-xl border border-white/12 shadow-2xl outline-none"
      style={{ left: pos.x, top: pos.y, width: PANEL_W, maxHeight: 'min(78vh, 720px)' }}
    >
      {/* 標題列可拖曳:面板常常需要讓開正在檢查的那塊區域 */}
      <div
        className="flex shrink-0 cursor-move items-center gap-2 border-b border-white/10 px-3 py-2"
        onPointerDown={(e) => {
          dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (!d) return
          setPos({
            x: Math.max(0, Math.min(window.innerWidth - 120, e.clientX - d.dx)),
            y: Math.max(0, Math.min(window.innerHeight - 32, e.clientY - d.dy))
          })
        }}
        onPointerUp={(e) => {
          dragRef.current = null
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400" />
        <span className="text-xs font-semibold tracking-wide">UI/UX DEBUG</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-ink-400">
          {app ? `v${app.version} · ${app.platform}` : '載入中'}
        </span>
        <span className="shrink-0 rounded bg-white/8 px-1.5 py-0.5 font-mono text-[10px] text-ink-300">
          Ctrl+Shift+D
        </span>
        <button
          onClick={() => useDebug.getState().togglePanel()}
          title="關閉除錯面板"
          className="shrink-0 cursor-pointer rounded p-1 text-ink-400 hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </div>

      <div className="flex shrink-0 gap-0.5 border-b border-white/10 px-2 py-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'cursor-pointer rounded-md px-2.5 py-1 text-[11px] transition-colors',
              tab === t.id ? 'bg-white/12 font-medium text-white' : 'text-ink-300 hover:bg-white/8'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {tab === 'state' && (
          <>
            <Section title="視窗">
              <Row k="主視窗" v={`${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`} />
              <Row
                k="浮層"
                v={info2 ? `${info2.width}×${info2.height} @${info2.scaleFactor}x` : '無'}
              />
              <Row k="浮層位置" v={info2 ? `${info2.x}, ${info2.y} · ${info2.visible ? '顯示' : '隱藏'}` : '—'} />
              <Row
                k="工作區"
                v={info2 ? `${info2.workArea.width}×${info2.workArea.height} @${info2.workArea.x},${info2.workArea.y}` : '—'}
              />
              <Row k="形態" v={shape} />
              <Row k="renderer 視窗" v={snapWin ? `${snapWin.w}×${snapWin.h} @${snapWin.dpr}x` : '未取得'} />
            </Section>

            <Section title="提詞引擎">
              <Row k="模式" v={mode} />
              <Row
                k="狀態"
                v={
                  snapshot
                    ? `${String(snapshot['status'])} · 句 ${String(snapshot['sentenceIndex'])} · 短語 ${String(
                        snapshot['phraseIndex']
                      )}`
                    : '—'
                }
              />
              <Row
                k="已過時間"
                v={snapshot ? formatDuration(Number(snapshot['elapsedMs'] ?? 0) / 1000) : '—'}
              />
              <Row k="scrollPos" v={snapshot ? String(Math.round(Number(snapshot['scrollPos'] ?? 0))) : '—'} />
              <Row
                k="語速 1×"
                v={`${o?.rate ?? 1}× → ${effRate.toFixed(2)}×${
                  personalBaseline ? `(個人基準 ${personalBaseline} 字/分)` : '(未校準,基準 120 WPM)'
                }`}
              />
            </Section>

            <Section title="跟讀 / 材質">
              <Row k="跟讀" v={follow ? `${follow.status ?? '?'} · chunk ${follow.activeChunk ?? -1}` : '—'} />
              <Row
                k="玻璃"
                v={snapshot ? `glass=${String(snapshot['glass'])} 折射=${String(snapshot['refractOk'])}` : '—'}
              />
              <Row
                k="擷取保護"
                v={snapshot ? `${String(snapshot['captureProtected'])} · 點擊穿透 ${String(snapshot['clickThrough'])}` : '—'}
              />
              <Row k="講稿長度" v={snapshot ? `${String(snapshot['contentLen'])} 字` : '—'} />
            </Section>

            <Section title="設定(overlay)">
              <pre className="max-h-48 overflow-auto rounded-lg bg-black/40 p-2 text-[10px] leading-relaxed text-ink-300">
                {JSON.stringify(o ?? {}, null, 2)}
              </pre>
            </Section>

            <Section title="浮層 renderer 快照">
              <pre className="max-h-56 overflow-auto rounded-lg bg-black/40 p-2 text-[10px] leading-relaxed text-ink-300">
                {snapshot ? JSON.stringify(snapshot, null, 2) : '未取得(浮層可能尚未建立)'}
              </pre>
            </Section>
          </>
        )}

        {tab === 'layout' && (
          <>
            <Section title="開關">
              <div className="flex flex-wrap gap-1.5">
                {LAYOUT_DEBUG_KEYS.map((k) => (
                  <Btn key={k} active={layout[k]} onClick={() => toggleLayout(k)}>
                    {LAYOUT_DEBUG_LABEL[k]}
                  </Btn>
                ))}
              </div>
            </Section>
            <Section title="圖例">
              <div className="space-y-1 text-[11px] leading-relaxed text-ink-300">
                <div>
                  <span className="mr-1.5 inline-block h-2.5 w-2.5 translate-y-[2px] rounded-sm border border-accent-400" />
                  元素外框:所有元素的邊界(看巢狀與留白)
                </div>
                <div>
                  <span className="mr-1.5 inline-block h-2.5 w-2.5 translate-y-[2px] rounded-sm border-2 border-rose-450" />
                  過小命中區:寬或高 &lt; 28px(與離線稽核同一標準)
                </div>
                <div>
                  <span className="mr-1.5 inline-block h-2.5 w-2.5 translate-y-[2px] rounded-sm border-2 border-dashed border-amber-450" />
                  被裁切:超出最近的不可捲動容器
                </div>
              </div>
            </Section>
            <Section title="游標檢視器">
              <div className="text-[11px] leading-relaxed text-ink-300">
                開啟後滑過任一元素會顯示 tag/class/尺寸/文字色;按一下複製該段描述並寫入 main.log。
                檢視器開啟期間點擊會被攔下來,看完記得關掉。
              </div>
            </Section>
          </>
        )}

        {tab === 'audit' && <AuditTab onShowLayout={toggleLayout} />}

        {tab === 'events' && (
          <>
            <div className="mb-2 flex gap-1.5">
              <Btn active={!paused} onClick={() => useDebug.getState().togglePaused()}>
                {paused ? '已暫停' : '記錄中'}
              </Btn>
              <Btn onClick={() => useDebug.getState().clear()}>清空</Btn>
              <Btn onClick={() => void refresh()}>重新抓快照</Btn>
            </div>
            <div
              ref={eventListRef}
              className="max-h-[52vh] overflow-y-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] leading-relaxed"
            >
              {events.length === 0 && <div className="text-ink-400">尚無事件</div>}
              {events.map((e, i) => (
                <div key={`${e.at}-${i}`} className="border-b border-white/5 py-1 last:border-0">
                  <span className="text-ink-400">{new Date(e.at).toLocaleTimeString()}</span>{' '}
                  <span className="text-accent-300">{e.scope}</span>{' '}
                  <span className="text-ink-100">{e.text}</span>
                  {e.detail && <div className="pl-4 break-all text-ink-400">{e.detail}</div>}
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'actions' && (
          <>
            <Section title="重現即時 UI(不必真的開會)">
              <div className="flex flex-wrap gap-1.5">
                <Btn onClick={() => void emit('turn')}>該你說話了</Btn>
                <Btn onClick={() => void emit('turn', 'peer_silence')}>對方停頓</Btn>
                <Btn onClick={() => void emit('coaching', '（除錯）語速偏快,放慢一點', 'fast')}>教練:語速</Btn>
                <Btn onClick={() => void emit('coaching', '（除錯）贅詞偏多', 'filler')}>教練:贅詞</Btn>
                <Btn onClick={() => void emit('coaching', '（除錯）冷場過久', 'dead_air')}>教練:冷場</Btn>
                <Btn onClick={() => void emit('panic')}>救援卡</Btn>
              </div>
            </Section>

            <Section title="浮層控制">
              <div className="flex flex-wrap gap-1.5">
                <Btn
                  onClick={() =>
                    void window.api.overlayShow({ title: '產品發表 · 開場', content: DEMO_SCRIPT })
                  }
                >
                  載入範例稿
                </Btn>
                <Btn onClick={() => void call('compact')}>藥丸</Btn>
                <Btn onClick={() => void call('expand')}>展開</Btn>
                <Btn onClick={() => void call('lens')}>貼鏡</Btn>
                <Btn onClick={() => void call('exit-lens')}>退出貼鏡</Btn>
                <Btn onClick={() => void call('play')}>播放</Btn>
                <Btn onClick={() => void call('pause')}>暫停</Btn>
                <Btn onClick={() => void call('follow')}>語音跟讀</Btn>
                <Btn onClick={() => void call('recenter')}>置中</Btn>
              </div>
            </Section>

            <Section title="視窗 / 設定">
              <div className="flex flex-wrap gap-1.5">
                <Btn onClick={() => void window.api.debugOpenDevTools('main')}>DevTools 主視窗</Btn>
                <Btn onClick={() => void window.api.debugOpenDevTools('overlay')}>DevTools 浮層</Btn>
                <Btn
                  active={o?.captureProtected}
                  onClick={() => {
                    // 浮層截圖/像素量測的前提:開了防擷取只會拍到背景(稽核腳本也踩過)
                    void window.api.overlaySetCaptureProtection(!(o?.captureProtected ?? true))
                    debugLog('debug', `captureProtected → ${!(o?.captureProtected ?? true)}`)
                  }}
                >
                  {o?.captureProtected ? '關閉擷取保護' : '開啟擷取保護'}
                </Btn>
                <Btn
                  active={o?.clickThrough}
                  onClick={() => void window.api.overlaySetClickThrough(!(o?.clickThrough ?? false))}
                >
                  滑鼠穿透
                </Btn>
                <Btn onClick={() => patchOverlay({ glass: !(o?.glass ?? true) })}>玻璃折射</Btn>
                <Btn onClick={() => void window.api.overlayHide()}>隱藏浮層</Btn>
              </div>
            </Section>

            <Section title="診斷">
              <div className="flex flex-wrap gap-1.5">
                <Btn onClick={() => void copyDiagnostics()}>複製診斷 JSON</Btn>
                <Btn onClick={() => void window.api.openLogDir()}>開記錄資料夾</Btn>
                <Btn onClick={() => window.location.reload()}>重載 renderer</Btn>
              </div>
              <div className="mt-2 text-[10px] leading-relaxed text-ink-400">
                診斷 JSON 含版本、視窗幾何、浮層快照、設定與最近 40 筆事件,可直接貼進 issue。
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  )
}
