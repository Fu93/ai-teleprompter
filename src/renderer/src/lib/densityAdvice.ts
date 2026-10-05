/**
 * densityAdvice.ts — 提詞密度建議(roadmap P3「提詞密度自適應」的重寫版)
 *
 * 為什麼是**建議**而不是自動切換:
 *   顯示模式決定「眼睛要怎麼動」—— 逐字追捲動、逐句跳、或只讀結構。
 *   使用者正在講話時發現模式被換掉,當下的反應是找設定而不是繼續講;
 *   而在台上找設定是最糟的一種打斷。所以建議出現在**他做決定的地方**
 *   (設定頁的顯示模式旁),切換仍然由他按。
 *
 * 為什麼用校準語速而不是逐場統計:
 *   語速基準是使用者自己朗讀量出來的(個人化校準),訊號乾淨;
 *   逐場統計混入了場合(面試 vs 閒聊)與對手快慢 —— 要用它之前得先有
 *   一個把場合正規化的模型,那不在這一輪(見 CHANGELOG 的「未做」清單)。
 *
 * 門檻怎麼來(不是憑感覺挑的):
 *   引擎的基準是 120 WPM(PhraseVisuals.DEFAULT_WPM),而專案各處都以它為 1×:
 *     快讀者 = 2.5× 基準(300 字/分以上)     → 重點要點
 *     慢讀者 = 1.5× 基準(180 字/分以下)     → 連續捲動
 *   兩個數字都落在校準自己的合理帶(100–480 字/分,見 isPlausibleRate)內,
 *   所以一個真的量出來的值有機會命中,而不會永遠落在建議之外。
 */
import type { OverlayDisplayMode } from '@shared/types'

/** 快讀者的下限(引擎基準 120 WPM 的 2.5×) */
export const DENSITY_FAST_CPM = 300
/** 慢讀者的上限(引擎基準 120 WPM 的 1.5×) */
export const DENSITY_SLOW_CPM = 180
/** 樣本太短的校準不值得拿來建議(量測時間不到 6 秒:數字本身就不穩) */
const MIN_SAMPLE_SEC = 6

/**
 * 建議只會是這兩個模式之一。
 *
 * phrase/karaoke 是**節奏**工具(以個人語速推進、逐詞高亮),
 * 而密度問題問的是「一眼要看多少字」—— 那是 scroll 與 bullet 的差別。
 * 把它窄化成兩個值,也讓呼叫端不可能拿到一個沒有標籤的模式。
 */
export type DensityMode = 'scroll' | 'bullet'

export interface DensityAdvice {
  mode: DensityMode
  /** 給使用者看的理由(含量到的數字,不是抽象的偏好) */
  reason: string
}

/**
 * 建議的顯示模式。null = 沒有建議(未校準、樣本太短、語速在中間帶、
 * 或現在的選擇就已經是建議值)。**不猜**:沒有量測就不說。
 */
export function suggestDisplayMode(
  profile: { charsPerMin: number; sampleSeconds: number } | null | undefined,
  current: OverlayDisplayMode
): DensityAdvice | null {
  if (!profile) return null
  const cpm = profile.charsPerMin
  if (!Number.isFinite(cpm) || cpm <= 0) return null
  if (!Number.isFinite(profile.sampleSeconds) || profile.sampleSeconds < MIN_SAMPLE_SEC) return null

  if (cpm >= DENSITY_FAST_CPM) {
    if (current === 'bullet') return null
    return {
      mode: 'bullet',
      reason: `你量到的語速是 ${Math.round(cpm)} 字/分（偏快）:重點要點模式只留結構,不必逐字追著捲動跑。`
    }
  }
  if (cpm <= DENSITY_SLOW_CPM) {
    if (current === 'scroll') return null
    return {
      mode: 'scroll',
      reason: `你量到的語速是 ${Math.round(cpm)} 字/分（偏慢）:逐字捲動讓你按自己的節奏推進,不會被分段跳轉打斷。`
    }
  }
  return null
}

/** 建議的模式的中文名(與設定頁的選項字串同一個出處語意,寫在這裡讓呼叫端不必再對照) */
export const DENSITY_MODE_LABEL: Record<DensityMode, string> = {
  bullet: '重點要點',
  scroll: '連續捲動'
}
