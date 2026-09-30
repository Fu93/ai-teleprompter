import type { JSX } from 'react'
import { Loader2, Siren, X } from 'lucide-react'
import type { RescuePayload } from '@shared/types'
import { cn } from '../lib/utils'
import { useEscape } from '../lib/useEscape'

/** v3 AICard 的信心顏色門檻:>=0.6 綠 / >=0.3 橙 / 其餘紅 */
function confidenceColor(confidence: number): string {
  if (confidence >= 0.6) return '#7CFF6B'
  if (confidence >= 0.3) return '#FFB845'
  return '#FF6B6B'
}

/**
 * @param compact 貼鏡模式(420×170)用。
 *
 * 為什麼需要一個尺寸參數:貼鏡視窗只有 170px 高,扣掉工具列(36) 與底部提示後
 * 幾乎沒有餘裕 —— 而救援卡的內容是動態的(句子長度、要點數)。原本同一個版面
 * 兩邊共用,於是貼鏡裡卡片底部的「信心條 + AI/模板來源標籤」被 overflow 切掉:
 * 那正好是使用者判斷「這句救援話能不能信」的唯一依據,卻是最先消失的部分。
 * 所以緊湊版把來源與信心搬到標題列(有空間時留在底部),並限制要點數。
 */
export function RescueCard({
  phase,
  rescue,
  errorMsg,
  onDismiss,
  compact = false
}: {
  phase: 'thinking' | 'rescue'
  rescue: RescuePayload | null
  errorMsg: string
  onDismiss: () => void
  compact?: boolean
}): JSX.Element {
  // Esc 關掉救援卡。它是浮層上層的暫態內容,而浮層經常有滑鼠穿透或失焦的狀況,
  // 只能靠滑鼠點右上角 ✕ 在實務上太脆弱(尤其簡報中只剩鍵盤可用)。
  useEscape(onDismiss)

  const points = rescue?.points ? rescue.points.split(' / ').filter(Boolean) : []
  // 緊湊版只留前兩個要點:170px 的視窗裝不下第三個,而「被切掉一半的要點」
  // 比「只給兩個」更糟 —— 使用者不會知道下面還有東西。
  const shownPoints = compact ? points.slice(0, 2) : points

  return (
    <div
      // 這是一張故意蓋住底下內容的暫態卡片(貼鏡只有 170px 高,不可能不蓋到正文)。
      // data-overlay-card 是給 DOM 稽核的明確宣告:它的子樹覆蓋到的東西不列入
      // text-covered —— 與 data-allow-h-scroll 同一套思路(工具分不出意圖,由元素宣告)。
      // 沒有這個宣告的話,一個設計上必然的覆蓋會永遠留在報告裡,
      // 而永遠紅的報告只會訓練人忽略它。
      data-overlay-card="rescue"
      className={cn('absolute inset-x-3 top-3 z-30 flex justify-center', !compact && 'inset-x-4 top-4')}
    >
      <div
        className={cn('glass-pill anim-rise w-full rounded-2xl', compact ? 'max-w-md p-3' : 'max-w-md p-4')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-rose-500/20 text-rose-400">
            {phase === 'thinking' ? <Loader2 size={13} className="animate-spin" /> : <Siren size={13} />}
          </span>
          <span className="shrink-0 text-xs font-semibold text-white/100">
            {phase === 'thinking' ? '救援思考中…' : 'Panic 救援'}
          </span>
          <span className="flex-1" />
          {/* 緊湊版把「信心 + 來源」搬進標題列:它們在底部時是最先被裁掉的,
              而它們決定使用者要不要相信這句話。 */}
          {compact && phase === 'rescue' && rescue && (
            <>
              <span className="shrink-0 font-mono text-[10px]" style={{ color: confidenceColor(rescue.confidence) }}>
                {Math.round(rescue.confidence * 100)}%
              </span>
              <span
                className={cn(
                  'shrink-0 rounded-full px-1.5 py-0.5 text-[10px]',
                  rescue.source === 'ai' ? 'bg-accent-500/20 text-accent-300' : 'bg-amber-450/15 text-amber-450'
                )}
              >
                {rescue.source === 'ai' ? 'AI' : '模板'}
              </span>
            </>
          )}
          <button
            onClick={onDismiss}
            // h-7 w-7(28px)而不是 h-5 w-5:這是浮層上最需要「一按就中」的東西
            // (Panic 當下沒有人有預算瞄準 20px),也對齊全站的命中區下限。
            // 圖示維持 11px,視覺大小不變。
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-white/52 hover:bg-white/10 hover:text-white"
            title="關閉"
          >
            <X size={11} />
          </button>
        </div>

        {phase === 'thinking' && (
          <div className={compact ? 'mt-2 space-y-1.5' : 'mt-3 space-y-2'}>
            <div className="shimmer h-4 w-4/5" />
            <div className="shimmer h-3 w-3/5" />
          </div>
        )}

        {phase === 'rescue' && rescue && rescue.sentence && (
          <>
            <div
              className={cn('font-medium leading-snug text-white/100 select-none', compact ? 'mt-1.5' : 'mt-2.5')}
              style={{ fontSize: compact ? 15 : 18, textShadow: '0 1px 4px rgba(0,0,0,0.6)' }}
            >
              {rescue.sentence}
            </div>
            {shownPoints.length > 0 && (
              <ul className={cn('text-white/72 select-none', compact ? 'mt-1 space-y-0 text-[11px]' : 'mt-2 space-y-0.5 text-xs')}>
                {shownPoints.map((p, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-rose-400">•</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            )}
            {!compact && (
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
                    'rounded-full px-1.5 py-0.5 text-[10px]',
                    rescue.source === 'ai' ? 'bg-accent-500/20 text-accent-300' : 'bg-amber-450/15 text-amber-450'
                  )}
                >
                  {rescue.source === 'ai' ? 'AI' : '模板'}
                </span>
              </div>
            )}
          </>
        )}

        {phase === 'rescue' && errorMsg && (
          <div className="mt-2 truncate text-[10px] text-white/52" title={errorMsg}>
            {errorMsg}
          </div>
        )}

        {phase === 'rescue' && rescue && !rescue.sentence && !errorMsg && (
          <div className="mt-2 text-xs text-white/52">準備中…</div>
        )}
      </div>
    </div>
  )
}
