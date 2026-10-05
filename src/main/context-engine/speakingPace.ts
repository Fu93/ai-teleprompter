/**
 * speakingPace.ts — 瞬時語速(10s 窗)與 ±10% 節奏判定(roadmap P4 的重寫版)
 *
 * 與 coachingRules 的 60s「語速過快」是什麼關係:
 *   - 60s 規則 = 教練:會出聲提醒,有 120s 冷卻,只在超過基準 1.3× 時說話。
 *   - 這裡 = 讀數:10s 窗、±10% 三色、不出聲、顯示中隨時可看。
 * 兩者共用同一個估計器 estimateCpm —— 兩份數學各自漂移的話,使用者會看到
 * 「讀數偏快但教練沒叫」或反過來,而兩邊都宣稱自己在量同一件事。
 *
 * 估計器的已知限制(寫在這裡,不假裝它是精確值):
 *   語音單位/分是用**送達間隔**估的,不是用音訊時長。段與段之間超過
 *   CONTINUATION_GAP_MS 的停頓不計入發聲時間;每段至少給 FIRST_SEGMENT_MS
 *   的保守 credit。連續短句時接近真實;長句停頓後才送達時會偏高。
 *   所以它是**趨勢讀數**,不是報告數字(會後報告用逐字稿的真實時長,
 *   見 renderer 的 session-intelligence)。
 *
 * 樣本不足時回 null,不回 0:0 是一個會被讀成「你完全沒在說話」的謊,
 * 而 null 讓 UI 選擇不出現。
 */

/** 未校準時的語速基準(與 coachingRules 同一個值;單一出處在這裡) */
export const DEFAULT_CPM = 300

/** 瞬時窗:10 秒(roadmap「最近 10 秒滑動窗口」) */
export const PACE_WINDOW_MS = 10_000

/** 三色帶寬:目標語速 ±10%(roadmap ON_TRACK 的定義) */
export const PACE_BAND = 0.1

/** 兩段送達間隔中,視為「連續發言」的最大間隔(超過即視為停頓,不計入發聲時間)。
 *  coachingRules 的 monologue 連續性判定也用它 —— 同一個語意(什麼算「還在講」)
 *  不該有兩份數字。 */
export const CONTINUATION_GAP_MS = 2_500
/** 窗內第一段本身的發聲時間不可得,給最小 credit(寧可低估語速) */
const FIRST_SEGMENT_MS = 1_500
/**
 * 窗內至少要這麼多發聲時間才有資格給數字。
 *
 * 為什麼需要:沒有這道下限時,**兩段、間隔 4 秒的慢速語音**會被算成
 * 「20 單位 ÷ 1.5 秒 = 800 字/分」——實測就是這樣誤報的
 * (coachingRules 的「正常語速不誤報」測試原本只看最後一次的回傳值,
 * 而最後一次剛好被 120s 冷卻壓成 null,把這個假陽性藏了起來)。
 */
const MIN_ACTIVE_MS = 3_000
/** 窗內至少要有這麼多語音單位,少於此不值得判讀 */
const MIN_UNITS = 6

export interface PaceSample {
  /** 送達時間戳(ms epoch) */
  t: number
  units: number
}

export type PaceVerdict = 'ahead' | 'on_track' | 'behind'

/**
 * 窗內語音單位/分。樣本不足(段數、單位數、發聲時間任一不足)回 null。
 */
export function estimateCpm(
  samples: readonly PaceSample[],
  now: number,
  windowMs: number
): number | null {
  const recent = samples.filter((s) => now - s.t < windowMs)
  if (recent.length < 2) return null
  const units = recent.reduce((a, b) => a + b.units, 0)
  if (units < MIN_UNITS) return null
  let activeMs = FIRST_SEGMENT_MS
  for (let i = 1; i < recent.length; i++) {
    const gap = recent[i].t - recent[i - 1].t
    if (gap <= CONTINUATION_GAP_MS) activeMs += gap
  }
  if (activeMs < MIN_ACTIVE_MS) return null
  return units / (activeMs / 60_000)
}

/**
 * 三色判定。邊界屬於 on_track(嚴格大於才算超前),因為「剛好 +10%」
 * 不是一個值得變色的偏離。
 */
export function paceVerdict(
  cpm: number | null,
  baselineCpm: number,
  band = PACE_BAND
): PaceVerdict | null {
  if (cpm === null || !Number.isFinite(cpm) || cpm <= 0) return null
  const baseline = baselineCpm > 0 ? baselineCpm : DEFAULT_CPM
  if (cpm > baseline * (1 + band)) return 'ahead'
  if (cpm < baseline * (1 - band)) return 'behind'
  return 'on_track'
}

export interface SmoothedPace {
  cpm: number | null
  verdict: PaceVerdict | null
}

/** 讀數的發送鍵:同一個鍵 = 同一個畫面狀態 */
export function paceKey(cpm: number | null, verdict: PaceVerdict | null): string {
  return cpm === null ? 'null' : `${cpm}|${verdict}`
}

/**
 * 這一次要不要送(送什麼由呼叫端組成)。
 *
 * 三條規則,每一條都對應一個具體的失敗:
 *   1. 鍵變了 → 一定要送。這是「畫面要改」的唯一來源。
 *   2. 鍵沒變且已經是 null → 不送。收起的訊號只需要送一次;
 *      沒有這一條,安靜的會議室每 2 秒都會收到一個 null。
 *   3. 鍵沒變且有數字 → 等心跳。**沒有這一條,讀數會在穩定時消失** ——
 *      renderer 有 8 秒過期清掃,而穩定正是最需要看到的時刻。
 */
export function paceEmitDecision(args: {
  key: string
  prevKey: string | null
  cpmIsNull: boolean
  now: number
  lastSentAt: number
  heartbeatMs: number
}): boolean {
  if (args.key !== args.prevKey) return true
  if (args.cpmIsNull) return false
  return args.now - args.lastSentAt >= args.heartbeatMs
}

/**
 * 顯示穩定器:近 3 次讀數的**中位數**,判定由中位數導出。
 *
 * 為什麼是中位數而不是 EMA:先試過 EMA(alpha 0.4),量出來的問題是
 * **回不去** —— 一次尖峰(3× 基準)之後要 7 次更新、約 14 秒才會回到
 * on_track,而使用者的實際感受是「我明明放慢了,顏色還說我快」。
 * 中位數濾波對單次跨界樣本的效果與 EMA 相同(直接濾掉),但真實變化
 * 一到就立刻跟上,沒有記憶尾巴。
 *
 * 2 筆時取中間平均、1 筆時就是它自己:樣本少的時候不要假裝有濾波效果。
 */
export function createPaceStabilizer(): {
  push: (cpm: number | null, baselineCpm: number, band?: number) => SmoothedPace
} {
  let last: number[] = []
  return {
    push(cpm, baselineCpm, band = PACE_BAND): SmoothedPace {
      if (cpm === null || !Number.isFinite(cpm) || cpm <= 0) {
        last = []
        return { cpm: null, verdict: null }
      }
      last = [...last, cpm].slice(-3)
      const sorted = [...last].sort((a, b) => a - b)
      const mid =
        sorted.length % 2 === 1
          ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      return { cpm: Math.round(mid), verdict: paceVerdict(mid, baselineCpm, band) }
    }
  }
}
