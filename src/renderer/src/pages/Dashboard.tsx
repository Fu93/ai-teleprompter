import type { JSX } from "react"
import { useEffect, useState } from 'react'
import { AudioLines, Eye, GraduationCap, Play, ScrollText, TrendingUp } from 'lucide-react'
import { db } from '../lib/db'
import type { MeetingSession, PracticeRun, Script } from '@shared/types'
import { formatDateTime } from '../lib/utils'
import { useSettings } from '../lib/store'
import { analyzePracticeRun } from '../lib/session-intelligence'

interface Props {
  onNavigate: (page: 'dashboard' | 'scripts' | 'record' | 'practice' | 'settings') => void
}

const MODES = [
  {
    id: 'scripts' as const,
    icon: ScrollText,
    title: '提詞浮層',
    desc: '講稿平滑滾動、置頂顯示、可隱形於螢幕分享',
    tint: 'from-accent-500 to-accent-600'
  },
  {
    id: 'record' as const,
    icon: AudioLines,
    title: '錄音轉錄',
    desc: '會議即時逐字稿，AI 自動生成摘要與待辦',
    tint: 'from-emerald-500 to-teal-600'
  },
  {
    id: 'practice' as const,
    icon: GraduationCap,
    title: '面試練習',
    desc: 'AI 出題並朗讀，針對你的回答給出反饋評分',
    tint: 'from-orange-500 to-rose-500'
  }
]

/** 輕量 SVG 折線(無圖表庫依賴);value 範圍自動正規化 */
function Sparkline({ values, stroke }: { values: number[]; stroke: string }): JSX.Element | null {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 120
  const h = 32
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - 3 - ((v - min) / span) * (h - 6)}`)
    .join(' ')
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export default function Dashboard({ onNavigate }: Props): JSX.Element {
  const [recent, setRecent] = useState<Script[]>([])
  const [sessions, setSessions] = useState<MeetingSession[]>([])
  const [runs, setRuns] = useState<PracticeRun[]>([])
  const { settings, overlayVisible } = useSettings()

  useEffect(() => {
    db.scripts.orderBy('updatedAt').reverse().limit(4).toArray().then(setRecent)
    db.sessions.orderBy('startedAt').reverse().limit(10).toArray().then(setSessions)
    db.practiceRuns.orderBy('createdAt').reverse().limit(10).toArray().then(setRuns)
  }, [])

  const launchLatest = async (): Promise<void> => {
    const s = recent[0]
    if (!s) return
    await db.scripts.update(s.id!, { lastUsedAt: Date.now() })
    await window.api.overlayShow({ title: s.title, content: s.content })
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">歡迎回來</h1>
        <p className="mt-1 text-sm text-ink-300">三大模式，隨時待命。</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => onNavigate(m.id)}
            className="card group p-5 text-left transition-all hover:border-ink-600 hover:bg-ink-850 cursor-pointer"
          >
            <div
              className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${m.tint} text-white`}
            >
              <m.icon size={19} />
            </div>
            <div className="font-semibold">{m.title}</div>
            <div className="mt-1 text-xs leading-relaxed text-ink-300">{m.desc}</div>
          </button>
        ))}
      </div>

      <div className="mt-8 card p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Eye size={15} className="text-accent-400" />
            提詞浮層
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              overlayVisible ? 'bg-emerald-500/15 text-emerald-400' : 'bg-ink-800 text-ink-400'
            }`}
          >
            {overlayVisible ? '顯示中' : '隱藏中'}
          </span>
        </div>
        {recent.length > 0 ? (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="truncate text-sm">{recent[0].title}</div>
              <div className="text-[11px] text-ink-400">
                最近編輯 {formatDateTime(recent[0].updatedAt)}
              </div>
            </div>
            <button className="btn-primary shrink-0" onClick={launchLatest}>
              <Play size={14} /> 開始提詞
            </button>
          </div>
        ) : (
          <div className="text-xs text-ink-400">
            還沒有講稿——到「提詞講稿」頁建立第一份吧。
          </div>
        )}
        {settings && (
          <div className="mt-3 border-t border-ink-800 pt-3 text-[11px] text-ink-400">
            浮層熱鍵 {settings.hotkeys.toggleOverlay} · 隱藏 {settings.hotkeys.hideOverlay} ·
            螢幕擷取隱形 {settings.overlay.captureProtected ? '開' : '關'}
          </div>
        )}
      </div>

      {/* 成長軌跡(session intelligence) */}
      {(sessions.length > 0 || runs.length > 0) && (
        <div className="mt-8 card p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium">
            <TrendingUp size={15} className="text-emerald-400" />
            成長軌跡
          </div>
          <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
            <div>
              <div className="text-[10px] text-ink-400">會議場數</div>
              <div className="mt-1 text-2xl font-semibold">{sessions.length}</div>
              <div className="text-[10px] text-ink-400">
                共 {Math.round(sessions.reduce((a, s) => a + (s.report?.durationSec ?? 0), 0) / 60)} 分鐘
              </div>
            </div>
            <div>
              <div className="text-[10px] text-ink-400">平均發言佔比</div>
              {(() => {
                const withRatio = sessions.filter((s) => s.report)
                const avg =
                  withRatio.length > 0
                    ? Math.round(
                        (withRatio.reduce((a, s) => a + (s.report?.talkRatio ?? 0), 0) / withRatio.length) * 100
                      )
                    : null
                return <div className="mt-1 text-2xl font-semibold">{avg != null ? `${avg}%` : '—'}</div>
              })()}
              <div className="text-[10px] text-ink-400">目標約 4–6 成</div>
            </div>
            <div>
              <div className="text-[10px] text-ink-400">語速趨勢(字/分)</div>
              <div className="mt-1 flex items-end gap-2">
                <span className="text-2xl font-semibold">
                  {sessions.find((s) => s.report?.myCpm)?.report?.myCpm ?? '—'}
                </span>
                <Sparkline
                  values={[...sessions].reverse().map((s) => s.report?.myCpm ?? 0).filter((v) => v > 0)}
                  stroke="#8f8cfa"
                />
              </div>
              <div className="text-[10px] text-ink-400">最近 {Math.min(sessions.length, 10)} 場</div>
            </div>
            <div>
              <div className="text-[10px] text-ink-400">練習分數趨勢</div>
              {(() => {
                const oldestFirst = [...runs].reverse()
                const scores = oldestFirst.map((r) => analyzePracticeRun(r.answers).scores).filter((s) => s.length > 0).map((s) => Math.round(s.reduce((a, b) => a + b, 0) / s.length))
                const latest = scores.length > 0 ? scores[scores.length - 1] : null
                return (
                  <div className="mt-1 flex items-end gap-2">
                    <span className="text-2xl font-semibold">{latest ?? '—'}</span>
                    <Sparkline values={scores} stroke="#2dd4a7" />
                  </div>
                )
              })()}
              <div className="text-[10px] text-ink-400">共 {runs.length} 次練習</div>
            </div>
          </div>
        </div>
      )}

      {recent.length > 1 && (
        <div className="mt-8">
          <div className="mb-3 text-sm font-medium text-ink-200">最近的講稿</div>
          <div className="space-y-2">
            {recent.slice(1).map((s) => (
              <div
                key={s.id}
                className="card flex items-center justify-between px-4 py-3 hover:bg-ink-850"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{s.title}</div>
                  <div className="text-[11px] text-ink-400">{formatDateTime(s.updatedAt)}</div>
                </div>
                <button
                  className="btn-ghost shrink-0 text-xs"
                  onClick={async () => {
                    await db.scripts.update(s.id!, { lastUsedAt: Date.now() })
                    await window.api.overlayShow({ title: s.title, content: s.content })
                  }}
                >
                  <Play size={13} /> 提詞
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
