/**
 * rescueAdaptation.ts — 救援時間預算的自適應(roadmap P3「動態恐慌閾值」的重寫版)
 *
 * 為什麼自適應的是**預算**而不是「觸發門檻」:
 *   這款 App 的救援沒有自動觸發 —— 唯一入口是使用者的熱鍵(Alt+P)。
 *   也就是說「動態調整觸發門檻」在本專案沒有可調的東西:把門檻調高只會讓
 *   熱鍵變成「有時候按了沒反應」,而那比慢一點嚴重得多。
 *   真正會卡住救援、而且隨供應商/網路/機器變動的是**產生救援卡的時間預算**
 *   —— 原本是硬編碼常數(Groq 900ms / 其他雲端 1500ms / 本地 2500ms)。
 *   超時 = 退回模板救援,使用者的感受是「AI 救援壞了」,而原因只是那台機器
 *   的實測延遲一直在預算之上。
 *
 * 只放寬、不收緊:
 *   收緊(本地模型實測 300ms,於是把預算壓到 400ms)唯一的效果是把
 *   「偶爾慢」變成「偶爾失敗」。救援卡是使用者在台上按下去的東西,
 *   失敗與成功的差別是 0 分與 60 分;而慢 1 秒的代價只是慢 1 秒。
 *
 * 樣本怎麼來、跨不跨場次:
 *   每一場按過救援、而且真的收到回應的那一次記一筆(超時的那次量到的是
 *   預算本身,不是 provider 的延遲 —— 記進去會讓預算自己把自己撐大)。
 *   樣本存在 settings.personal.profile(跟著設定檔落盤),換供應商就重新累積
 *   —— Groq 的 900ms 與本地 Ollama 的 2500ms 不是同一個分佈,混在一起
 *   只會讓兩邊都不準。
 */

/** 保留的樣本數上限(近 8 次按救援的延遲就足以代表現況) */
export const RESCUE_KEEP_SAMPLES = 8
/** 放寬的上限:救援卡等超過 4 秒,救援的時機已經過去了 */
export const DEFAULT_RESCUE_CAP_MS = 4_000
/** 少於這個樣本數就不動預算:兩個樣本可能是同一種偶然 */
const MIN_SAMPLES = 3
/** 以 p75 × 1.5 放寬:偶爾慢的那一側也要接得住,而不是只接住中位數 */
const WIDEN_FACTOR = 1.5

/** 最近似定義的百分位(ceil 取索引):樣本少時取較慢的那一側,不取樂觀值 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/**
 * 這一回合的救援時間預算。樣本不足回 base(未放寬);
 * 有樣本則取 max(base, p75×1.5),並夾在 [base, cap] 內 —— 永遠不會比 base 小。
 */
export function adaptiveRescueTimeout(
  baseMs: number,
  samples: readonly number[],
  capMs = DEFAULT_RESCUE_CAP_MS
): number {
  const usable = samples.filter((n) => Number.isFinite(n) && n > 0)
  if (usable.length < MIN_SAMPLES) return baseMs
  const widened = Math.round(percentile(usable, 0.75) * WIDEN_FACTOR)
  const cap = Math.max(baseMs, capMs)
  return Math.max(baseMs, Math.min(widened, cap))
}

/** 記一筆成功的救援延遲(就地修剪到 RESCUE_KEEP_SAMPLES 筆)。 */
export function recordRescueSample(samples: number[], ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return
  samples.push(Math.round(ms))
  if (samples.length > RESCUE_KEEP_SAMPLES) {
    samples.splice(0, samples.length - RESCUE_KEEP_SAMPLES)
  }
}
