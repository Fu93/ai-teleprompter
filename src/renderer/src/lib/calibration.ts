// 個人化校準公式：瞳距像素 → 觀看距離 → 字級；個人語速 → 滾動速度
// 物理近似說明：
//   1. 觀看距離 d = f_px × IPD_mm ÷ pixelIPD，其中 f_px = (畫面寬/2) ÷ tan(HFOV/2)。
//      一般筆電內建攝影機 HFOV 約 60~70°，預設取 65°；誤差主要來自 FOV 假設。
//   2. 字級：目標是讓文字在實際視距下佔約 0.7~1.1° 視角（提詞閱讀比一般閱讀大）。
//      在 Windows 建議縮放之下 CSS px 的實體尺寸近似 96dpi 基準，故用
//      fontSizePx ≈ d_cm × K 的線性近似（K 由目標視角推導），再提供 ±微調兜底。
//   3. 滾動速度：中文字寬 ≈ 1em（= fontSize px），故
//      speed(px/s) = charsPerMin ÷ 60 × fontSize。

/** 預設攝影機水平視場角（度）——典型筆電 webcam */
export const DEFAULT_HFOV_DEG = 65

/** 目標視角（度）——文字高度在觀看處張開的角度，取中間值 */
export const TARGET_VISUAL_ANGLE_DEG = 0.9

/** 字級線性係數：fontSize(px) ≈ d(cm) × K
 *  推導：h = 2·d·tan(θ/2)（θ=0.9°），以 96dpi CSS px 與常見筆電縮放歸一後 ≈ 0.58 px/cm
 */
export const FONT_SIZE_PER_CM = 0.58

export const MIN_FONT_SIZE = 16
export const MAX_FONT_SIZE = 72

export interface DistanceEstimateInput {
  /** 兩瞳孔（虹膜中心）在畫面中的正規化距離 [0,1] × 畫面寬 = 像素距離 */
  normalizedIpd: number
  frameWidthPx: number
  ipdMm: number
  hfovDeg?: number
}

/** 由瞳孔像素距離推估觀看距離（cm） */
export function estimateDistanceCm(input: DistanceEstimateInput): number {
  const hfov = input.hfovDeg ?? DEFAULT_HFOV_DEG
  const fPx = input.frameWidthPx / 2 / Math.tan((hfov / 2) * (Math.PI / 180))
  const pixelIpd = input.normalizedIpd * input.frameWidthPx
  if (pixelIpd <= 0) return 0
  const distanceMm = (fPx * input.ipdMm) / pixelIpd
  return distanceMm / 10
}

/** 由觀看距離推導建議字級（px） */
export function fontSizeFromDistance(distanceCm: number): number {
  const raw = distanceCm * FONT_SIZE_PER_CM
  return Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, raw)))
}

/** 由個人語速與字級推導滾動速度（px/s） */
export function speedFromRate(charsPerMin: number, fontSize: number): number {
  return Math.round(charsPerMin / 60 * fontSize)
}

/** 由觀看距離與字級反推等效視角（度），供 UI 顯示 */
export function visualAngleDeg(distanceCm: number, fontSizePx: number): number {
  const heightMm = (fontSizePx / 96) * 25.4 // 96dpi CSS 基準的實體高度近似
  const distanceMm = distanceCm * 10
  if (distanceMm <= 0) return 0
  return 2 * Math.atan(heightMm / 2 / distanceMm) * (180 / Math.PI)
}

/** 由視距與實際字級計算等效目標視角的建議字級（微調基準） */
export function clampFontSize(px: number): number {
  return Math.round(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, px)))
}

/**
 * 計算朗讀轉錄文字的「可讀字數」：
 * 中文字逐字計；英數字串（單字）每個視為 1 字（中文語速基準的等效換算）。
 * 移除標點、空白與符號。
 */
export function countReadableChars(transcript: string): number {
  const cleaned = transcript
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim()
  if (!cleaned) return 0
  const cjk = cleaned.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)?.length ?? 0
  const latinWords = cleaned.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length
  return cjk + latinWords
}

/** 語速合理性檢查：正常人朗讀中文約 160~400 字/分 */
export function isPlausibleRate(charsPerMin: number): boolean {
  return charsPerMin >= 100 && charsPerMin <= 480
}

/** 瞳距的合理範圍（mm）。輸入框的 min/max 屬性擋不住手打，真正生效的夾限在 clampIpdMm */
export const MIN_IPD_MM = 50
export const MAX_IPD_MM = 80

/**
 * 夾限瞳距輸入。
 *
 * 為什麼需要：type=number 的 min/max 只擋 spinner 不擋鍵盤，631 會原樣進入
 * 距離估算；而非數值（清空）回退成人平均 63。由 blur 時呼叫 —— 輸入過程中
 * 不強迫改值，否則清空瞬間被彈回 63，使用者永遠無法「刪掉重打」。
 */
export function clampIpdMm(v: number): number {
  // Number('') is 0 rather than NaN; treat a cleared number input as the same
  // missing-value fallback instead of clamping it to an implausible 50 mm.
  if (!Number.isFinite(v) || v <= 0) return 63
  return Math.min(MAX_IPD_MM, Math.max(MIN_IPD_MM, Math.round(v)))
}

/**
 * 個人語速 → 定時引擎的有效倍率。
 * 引擎以 defaultWpm（120）為 1× 基準；校準後 1× 應代表「使用者自己的語速」，
 * 故有效倍率 = sliderRate × 個人語速 ÷ 基準語速。未校準時原樣返回。
 */
export function effectiveEngineRate(
  sliderRate: number,
  personalCpm: number | null | undefined,
  defaultWpm = 120
): number {
  const baseline = personalCpm != null && personalCpm > 0 ? personalCpm : defaultWpm
  return (sliderRate * baseline) / defaultWpm
}

/**
 * 開了相機之後,等第一格影像的逾時。
 *
 * 為什麼需要這個數字:不是每一種相機失敗都會讓 `getUserMedia` 丟錯。
 * 「驅動被別的程式占住、USB hub 掉電、驅動卡住」會**成功**拿到 stream,
 * 然後永遠送不出第一格影像。沒有逾時,使用者的畫面就是:全黑預覽、燈亮著、
 * 按鈕寫「等待距離穩定…」—— 而且永遠是那一句。那比直接報錯還糟。
 *
 * 8 秒的依據:實機冷啟動最慢的 webcam 約 2 秒出第一格,而「使用者開始不耐煩」
 * 大約在 8 秒。寧可晚一點報錯,也不要誤判一個只是慢的相機。
 */
export const CAMERA_FIRST_FRAME_TIMEOUT_MS = 8000

/**
 * 「這個 video 真的有在送影」的判定。
 *
 * 為什麼兩個條件都要:readyState >= 2(HAVE_CURRENT_DATA)代表有**當前**影格,
 * videoWidth > 0 代表那一格有寬度。有些環境會給 readyState >= 2 但寬度 0
 * (track 已連上但格式還沒確定);反過來也可能寬度已知但還沒收到影格。
 * 只看其中一個會在其中一種情況裡誤判。
 *
 * 這是抽出來的原因:呼叫端在計時器到點與每一個 rAF tick 都會用到它,
 * 而「逾時會不會誤殺一個只是慢的相機」是那個計時器最該被驗的行為 ——
 * 而那只能在純函式上測。
 */
export function isCameraDeliveringFrames(video: { readyState: number; videoWidth: number }): boolean {
  return video.readyState >= 2 && video.videoWidth > 0
}
