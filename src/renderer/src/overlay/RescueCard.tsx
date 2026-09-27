import type { JSX } from 'react'
import { Loader2, Siren, X } from 'lucide-react'
import type { RescuePayload } from '@shared/types'
import { cn } from '../lib/utils'

/** v3 AICard 的信心顏色門檻:>=0.6 綠 / >=0.3 橙 / 其餘紅 */
function confidenceColor(confidence: number): string {
  if (confidence >= 0.6) return '#7CFF6B'
  if (confidence >= 0.3) return '#FFB845'
  return '#FF6B6B'
}

export function RescueCard({
  phase,
  rescue,
  errorMsg,
  onDismiss
}: {
  phase: 'thinking' | 'rescue'
  rescue: RescuePayload | null
  errorMsg: string
  onDismiss: () => void
}): JSX.Element {
  return (
    <div className="absolute inset-x-4 top-4 z-20 flex justify-center">
      <div
        className="glass-pill anim-rise w-full max-w-md rounded-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-rose-500/20 text-rose-400">
            {phase === 'thinking' ? <Loader2 size={13} className="animate-spin" /> : <Siren size={13} />}
          </span>
          <span className="text-xs font-semibold text-ink-100">
            {phase === 'thinking' ? '救援思考中…' : 'Panic 救援'}
          </span>
          <span className="flex-1" />
          <button
            onClick={onDismiss}
            className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-ink-400 hover:bg-white/10 hover:text-white"
            title="關閉"
          >
            <X size={11} />
          </button>
        </div>

        {phase === 'thinking' && (
          <div className="mt-3 space-y-2">
            <div className="shimmer h-4 w-4/5" />
            <div className="shimmer h-3 w-3/5" />
          </div>
        )}

        {phase === 'rescue' && rescue && rescue.sentence && (
          <>
            <div
              className="mt-2.5 font-medium leading-snug text-white select-none"
              style={{ fontSize: 18, textShadow: '0 1px 4px rgba(0,0,0,0.6)' }}
            >
              {rescue.sentence}
            </div>
            {rescue.points && (
              <ul className="mt-2 space-y-0.5 text-xs text-ink-200 select-none">
                {rescue.points
                  .split(' / ')
                  .filter(Boolean)
                  .map((p, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="text-rose-400">•</span>
                      <span>{p}</span>
                    </li>
                  ))}
              </ul>
            )}
            <div className="mt-3 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${Math.round(rescue.confidence * 100)}%`, background: confidenceColor(rescue.confidence) }}
                />
              </div>
              <span className="font-mono text-[10px]" style={{ color: confidenceColor(rescue.confidence) }}>
                {Math.round(rescue.confidence * 100)}%
              </span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[9px]',
                  rescue.source === 'ai' ? 'bg-accent-500/20 text-accent-300' : 'bg-amber-450/15 text-amber-450'
                )}
              >
                {rescue.source === 'ai' ? 'AI' : '模板'}
              </span>
            </div>
          </>
        )}

        {phase === 'rescue' && errorMsg && (
          <div className="mt-2 truncate text-[10px] text-ink-400" title={errorMsg}>
            {errorMsg}
          </div>
        )}

        {phase === 'rescue' && rescue && !rescue.sentence && !errorMsg && (
          <div className="mt-2 text-xs text-ink-400">準備中…</div>
        )}
      </div>
    </div>
  )
}
