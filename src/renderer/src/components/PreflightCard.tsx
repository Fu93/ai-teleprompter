/**
 * PreflightCard.tsx — 「這台電腦還差什麼」的畫面(判斷在 lib/preflight.ts)。
 *
 * 為什麼是一張卡片而不是入口的強制精靈:
 *   見 lib/preflight.ts 檔頭第一點。擋路的精靈會讓只想看看浮層長什麼樣的人
 *   永遠進不去,而「進不去」比「沒提醒」更致命。
 *
 * 刻意做的事:
 *   - 每一項都有「怎麼做」,而且是可以照著做的具體步驟。
 *   - `ollama pull …` 給一顆**可點的複製鈕**。使用者要在他自己的終端機打,
 *     複製比手抄可靠 —— 手抄 40 個字元錯一個就是又一轮除錯。
 *   - 複製成功要有回饋(按鈕文字變了),否則使用者不知道有沒有複製到。
 *   - 嚴重度分三級用三種視覺,而不是全部紅色。只有一個問題時用全部紅色,
 *     會讓人以為整個程式壞了。
 *   - 關閉之後記得住了,同一個問題不會每次開 App 都跳出來騷擾 —— 但擋路級
 *     永遠會回來(它還沒解決)。這個差別是刻意的:提示可以消失,阻斷不行。
 */
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronUp, Copy, ExternalLink, Info } from 'lucide-react'
import { useSettings } from '../lib/store'
import { registerAuditControl } from '../lib/auditBridge'
import {
  evaluatePreflight,
  probeOllama,
  setAuditOllama,
  useOllamaAuditOverride,
  OLLAMA_DOWNLOAD_URL,
  type PreflightResult,
  type PreflightItem
} from '../lib/preflight'
import { cn } from '../lib/utils'
import { toast } from '../lib/toast'

const DISMISS_KEY = 'ai-tp.preflight.dismissed'

/** 只記得「使用者看過並且不再想看」的是哪些 id;擋路級永遠不記。 */
function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}
function writeDismissed(ids: string[]): void {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(ids))
  } catch {
    /* localStorage 不可得(隱私模式)時放棄記得,而不是讓整張卡片壞掉 */
  }
}

export interface PreflightCardProps {
  /** compact:只顯示一行摘要(總覽頁用);full:完整卡片(設定頁用) */
  variant?: 'compact' | 'full'
  onNavigate?: (page: 'settings' | 'record' | 'practice') => void
}

export function PreflightCard({ variant = 'full', onNavigate }: PreflightCardProps): JSX.Element | null {
  const settings = useSettings((s) => s.settings)
  // 訂閱 audit 覆寫狀態:它改變時要重跑查詢並重畫(見下方 effect 的 deps)
  const auditOverride = useOllamaAuditOverride()
  const [models, setModels] = useState<string[] | null>(null)
  const [reachable, setReachable] = useState<boolean | null>(null)
  const [keys, setKeys] = useState<{ stt: boolean; ai: boolean }>({ stt: false, ai: false })
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed())
  const [expanded, setExpanded] = useState(variant === 'full')
  const [copied, setCopied] = useState<string | null>(null)

  // 真去查,不是推測。keysGet 回來的是 secure store,settings 裡的 apiKey
  // 可能是舊的備援值 —— 兩個都看,任一個有就算填過。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const k = await window.api?.keysGet?.()
        if (!alive) return
        const s = settings
        setKeys({
          stt: !!k?.sttApiKey || !!s?.stt?.cloud?.apiKey,
          ai: !!k?.apiKey || !!s?.ai?.openaiCompatible?.apiKey
        })
      } catch {
        /* 讀不到金鑰狀態不算錯:那就把兩項都當未填,卡片會多問一次,不會少問 */
      }
    })()
    return () => {
      alive = false
    }
  }, [settings])

  useEffect(() => {
    if (!settings || settings.ai.provider !== 'ollama') return
    let alive = true
    void (async () => {
      const r = await probeOllama(settings.ai.ollama.baseUrl)
      if (alive) {
        setModels(r.models)
        // installed 與「models 長度」是兩個獨立的事:裝了沒拉模型是一種狀態,
        // 沒裝是另一種。它們要給不同的指引,不能合併成「沒有模型」。
        setReachable(r.installed)
      }
    })()
    return () => {
      alive = false
    }
    // auditOverride 在 deps 裡:測試(或除錯者)改變模擬狀態時,查詢要重跑。
    // 少了它,「改完沒反應」會被誤讀成「卡片壞了」。
  }, [settings, auditOverride])

  // audit 控制項註冊在**這裡**,而不是 main.tsx。
  // 兩個理由:一是控制項只在使用者看得到這張卡片時才有意義;
  // 二是 main.tsx 匯入 preflight.ts 會把 whisperClient(以及它那 1.3MB 的
  // worker 依賴鏈)拖進入口 chunk —— 為了兩個測試鉤子讓每次啟動都多付這筆,
  // 不划算。註冊在 effect 裡,卸載時取消,語意與 registry 的設計一致。
  useEffect(() => {
    const offModels = registerAuditControl('preflight.models', (arg) => {
      setAuditOllama(Array.isArray(arg) ? (arg as string[]) : null)
      return true
    })
    const offDown = registerAuditControl('preflight.ollamaDown', (arg) => {
      setAuditOllama([], arg === true)
      return true
    })
    return () => {
      offModels()
      offDown()
    }
  }, [])

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      toast.error('複製失敗。手動選取這行字複製也可以:' + text)
    }
  }, [])

  const result: PreflightResult = evaluatePreflight({
    settings,
    ollamaModels: reachable ? models : null,
    ollamaReachable: reachable ?? false,
    cloudSttKeyPresent: keys.stt,
    cloudAiKeyPresent: keys.ai
  })

  // 還在查 ollama 時不要急著宣布「你少東西」—— 那會是一個假的紅字。
  const stillChecking = settings?.ai.provider === 'ollama' && reachable === null
  if (!settings || stillChecking) return null

  const visible = result.items.filter((i) => i.severity === 'blocking' || !dismissed.includes(i.id))

  // 「什麼都不缺」這句話由**本元件**自己畫,而不是讓呼叫端去猜。
  // 原因:本地 Whisper 的下載提示永遠存在(模型快取由 transformers 管理,
  // renderer 看不到它到底下載過沒有),所以 severity==='ready' 在本地 STT
  // 下永遠不會出現。若由呼叫端決定要不要顯示「都準備好了」,它會和卡片
  // 同時出現,兩句互相矛盾的話並排 —— 那比沒有提示更糟。
  // 這裡的判斷是「沒有擋路項」,那才是使用者真正在意的:能不能開始。
  if (visible.length === 0) {
    if (variant !== 'full') return null
    return (
      <div data-preflight="ready" className="flex items-center gap-2 text-[11px] text-ink-400">
        <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />
        <span>AI 模型與語音辨識都準備好了,可以直接開始。</span>
      </div>
    )
  }

  const act = (item: PreflightItem): void => {
    if (item.action?.kind === 'copy') void copy(item.action.text)
    else if (item.action?.kind === 'external') void window.api?.openExternal?.(item.action.url)
    else if (item.action?.kind === 'goto') onNavigate?.(item.action.page)
  }

  const dismiss = (item: PreflightItem): void => {
    if (item.severity === 'blocking') {
      // 擋路級不記:它還沒解決,記了等於讓它永久消失。
      toast.info('這個還沒解決,卡片會一直顯示。')
      return
    }
    const next = [...new Set([...dismissed, item.id])]
    setDismissed(next)
    writeDismissed(next)
  }

  const blockingCount = visible.filter((i) => i.severity === 'blocking').length
  const tone = blockingCount > 0 ? 'amber' : 'sky'

  if (variant === 'compact') {
    const first = visible[0]
    return (
      <button
        type="button"
        data-preflight="compact"
        onClick={() => onNavigate?.('settings')}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-xs',
          blockingCount > 0
            ? 'border-amber-400/30 bg-amber-400/10 hover:bg-amber-400/15'
            : 'border-sky-400/25 bg-sky-400/10 hover:bg-sky-400/15'
        )}
      >
        {blockingCount > 0 ? (
          <AlertTriangle size={14} className="shrink-0 text-amber-400" />
        ) : (
          <Info size={14} className="shrink-0 text-sky-300" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-ink-100">
            {blockingCount > 0 ? `還差 ${blockingCount} 項才能開始` : '有 1 件事要先知道'}
          </span>
          <span className="mt-0.5 block truncate text-ink-400">{first.title}</span>
        </span>
        <span className="shrink-0 text-ink-400">前往設定 →</span>
      </button>
    )
  }

  return (
    <div
      data-preflight="card"
      data-severity={result.severity}
      className={cn(
        'rounded-xl border px-4 py-3.5',
        tone === 'amber' ? 'border-amber-400/30 bg-amber-400/8' : 'border-sky-400/25 bg-sky-400/8'
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2.5 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {blockingCount > 0 ? (
          <AlertTriangle size={15} className="shrink-0 text-amber-400" />
        ) : (
          <Info size={15} className="shrink-0 text-sky-300" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-ink-100">
            {blockingCount > 0 ? '開始之前,這台電腦還差這些' : '開始之前,先知道這件事'}
          </span>
          <span className="mt-0.5 block text-[11px] text-ink-400">
            {visible.length} 項 · 設定與提詞本身不受影響,可以先到處看看
          </span>
        </span>
        {expanded ? <ChevronUp size={15} className="shrink-0 text-ink-400" /> : <ChevronDown size={15} className="shrink-0 text-ink-400" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2.5">
          {visible.map((item) => (
            <div key={item.id} data-preflight-item={item.id} className="rounded-lg bg-black/20 px-3 py-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-ink-100">{item.title}</div>
                  <div className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-ink-300">{item.how}</div>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
                    item.severity === 'blocking' ? 'bg-amber-400/15 text-amber-300' : 'bg-sky-400/15 text-sky-300'
                  )}
                >
                  {item.severity === 'blocking' ? '需要先處理' : '第一次會等一下'}
                </span>
              </div>

              {item.command && (
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1.5 font-mono text-[11px] text-ink-100">
                    {item.command}
                  </code>
                  {/* 複製鈕:使用者要在自己的終端機打,複製比手抄可靠。
                      aria-label 必須跟著狀態變 —— 它會**取代**可見文字成為無障礙名稱,
                      只寫「複製指令：…」的話,按下去之後螢幕閱讀器完全沒有回饋
                      (畫面上有「已複製」但讀不到)。 */}
                  <button
                    type="button"
                    className="btn-outline shrink-0 text-[11px]"
                    onClick={() => void copy(item.command!)}
                    aria-label={
                      copied === item.command
                        ? `已複製指令：${item.command}`
                        : `複製指令：${item.command}`
                    }
                  >
                    {copied === item.command ? <Check size={12} className="mr-1 text-emerald-400" /> : <Copy size={12} className="mr-1" />}
                    {copied === item.command ? '已複製' : '複製'}
                  </button>
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {item.action && item.action.kind === 'external' && (
                  <button type="button" className="btn-outline text-[11px]" onClick={() => act(item)}>
                    <ExternalLink size={12} className="mr-1" />
                    下載 Ollama
                  </button>
                )}
                {item.action && item.action.kind === 'goto' && (
                  <button type="button" className="btn-outline text-[11px]" onClick={() => act(item)}>
                    {item.command ? '去設定頁' : '前往設定'}
                  </button>
                )}
                {item.severity !== 'blocking' && (
                  <button
                    type="button"
                    className="text-[11px] text-ink-400 underline-offset-2 hover:text-ink-300 hover:underline"
                    onClick={() => dismiss(item)}
                  >
                    知道了,不用再提醒
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export { OLLAMA_DOWNLOAD_URL }
