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
