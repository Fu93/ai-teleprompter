import { describe, expect, it } from 'vitest'
import {
  CAMERA_FIRST_FRAME_TIMEOUT_MS,
  clampIpdMm,
  countReadableChars,
  effectiveEngineRate,
  estimateDistanceCm,
  fontSizeFromDistance,
  gazeOffsetDeg,
  isCameraDeliveringFrames,
  isPlausibleRate,
  pxToCm96dpi,
  speedFromRate,
  visualAngleDeg
} from '../calibration'

describe('estimateDistanceCm 瞳距像素 → 觀看距離', () => {
  it('典型情境：63mm 瞳距在 60cm 距離的像素大小，反推回 60cm', () => {
    // 正推：f_px = (640/2)/tan(65°/2) ≈ 477.9；60cm 處 pixelIPD = 477.9×63/600 ≈ 50.2px
    const hfov = 65
    const frameWidth = 640
    const fPx = frameWidth / 2 / Math.tan(((hfov / 2) * Math.PI) / 180)
    const distanceCm = 60
    const pixelIpd = (fPx * 63) / (distanceCm * 10)
    const normalizedIpd = pixelIpd / frameWidth

    const est = estimateDistanceCm({ normalizedIpd, frameWidthPx: frameWidth, ipdMm: 63, hfovDeg: hfov })
    expect(est).toBeCloseTo(distanceCm, 1)
  })

  it('距離越遠、正規化瞳距越小', () => {
    const near = estimateDistanceCm({ normalizedIpd: 0.12, frameWidthPx: 640, ipdMm: 63 })
    const far = estimateDistanceCm({ normalizedIpd: 0.06, frameWidthPx: 640, ipdMm: 63 })
    expect(far).toBeGreaterThan(near)
  })

  it('瞳距為 0 時不除以零', () => {
    expect(estimateDistanceCm({ normalizedIpd: 0, frameWidthPx: 640, ipdMm: 63 })).toBe(0)
  })
})

describe('fontSizeFromDistance 視距 → 字級', () => {
  it('60cm 約 35px（0.58 px/cm）', () => {
    expect(fontSizeFromDistance(60)).toBe(35)
  })
  it('上下限夾擠：太近不低於 16、太遠不高於 72', () => {
    expect(fontSizeFromDistance(10)).toBe(16)
    expect(fontSizeFromDistance(300)).toBe(72)
  })
})

describe('speedFromRate 語速 → 滾動速度', () => {
  it('240 字/分、35px 字級 → 140 px/s', () => {
    expect(speedFromRate(240, 35)).toBe(140)
  })
  it('語速越快速度越快', () => {
    expect(speedFromRate(300, 30)).toBeGreaterThan(speedFromRate(200, 30))
  })
})

describe('visualAngleDeg', () => {
  it('60cm、35px 字級的視角約 0.9°', () => {
    expect(visualAngleDeg(60, 35)).toBeGreaterThan(0.7)
    expect(visualAngleDeg(60, 35)).toBeLessThan(1.1)
  })
})

describe('countReadableChars 可讀字數', () => {
  it('中文逐字計，標點空白不算', () => {
    expect(countReadableChars('大家好，很高興見面！')).toBe(8)
  })
  it('英文單字視為 1 字', () => {
    expect(countReadableChars('hello world 測試')).toBe(4) // 2 英文字 + 2 中文字
  })
  it('空字串為 0', () => {
    expect(countReadableChars('')).toBe(0)
    expect(countReadableChars('。。。？！')).toBe(0)
  })
})

describe('isPlausibleRate 語速合理性', () => {
  it('正常朗讀 160~400 字/分為合理', () => {
    expect(isPlausibleRate(240)).toBe(true)
    expect(isPlausibleRate(180)).toBe(true)
  })
  it('極端值不合理', () => {
    expect(isPlausibleRate(50)).toBe(false)
    expect(isPlausibleRate(600)).toBe(false)
  })
})

describe('effectiveEngineRate 個人語速 → 引擎有效倍率', () => {
  it('未校準時倍率原樣返回', () => {
    expect(effectiveEngineRate(1, null)).toBe(1)
    expect(effectiveEngineRate(1.5, undefined)).toBe(1.5)
  })
  it('個人語速 240 字/分、倍率 1 → 有效 2×（引擎基準 120）', () => {
    expect(effectiveEngineRate(1, 240)).toBe(2)
  })
  it('個人語速 240、倍率 0.5 → 有效 1×（恰好等於引擎原基準）', () => {
    expect(effectiveEngineRate(0.5, 240)).toBe(1)
  })
  it('慢速 60 字/分 → 有效 0.5×', () => {
    expect(effectiveEngineRate(1, 60)).toBe(0.5)
  })
  it('自訂引擎基準', () => {
    expect(effectiveEngineRate(1, 240, 240)).toBe(1)
  })
})

describe('clampIpdMm 瞳距夾限', () => {
  it('範圍內原樣返回（整數）', () => {
    expect(clampIpdMm(63)).toBe(63)
    expect(clampIpdMm(58)).toBe(58)
  })
  it('超過上限/下限被夾進 50–80(type=number 的 min/max 擋不住手打)', () => {
    expect(clampIpdMm(631)).toBe(80)
    expect(clampIpdMm(5)).toBe(50)
  })
  it('非數值(清空)回退成人平均 63', () => {
    expect(clampIpdMm(Number(''))).toBe(63)
    expect(clampIpdMm(NaN)).toBe(63)
  })
  it('小數四捨五入', () => {
    expect(clampIpdMm(62.4)).toBe(62)
    expect(clampIpdMm(62.6)).toBe(63)
  })
})

/**
 * 這組測的是「逾時會不會誤殺一個只是慢的相機」。
 *
 * 為什麼值得獨立成一個 describe:這個計時器的失敗型態有兩種, 而且兩種都是
 * 使用者看得見的悲劇 ——
 *   1. 太寬鬆 → 相機真的壞掉時,使用者盯著全黑的畫面等「等待距離穩定…」,
 *      永遠等不到(這是修它要解決的問題)。
 *   2. 太緊 → 只是開機慢一點的相機被誤判成壞掉, 使用者看到一句他完全
 *      無法理解的錯, 而實際上拔插一下 USB 就好了。
 * 第 2 種比沒有逾時更糟, 因為它讓一個健康的裝置看起來壞了。
 */
describe('isCameraDeliveringFrames 判定相機真的有在送影', () => {
  it('readyState 0(HAVE_NOTHING):還沒收到任何資料,不算有影', () => {
    expect(isCameraDeliveringFrames({ readyState: 0, videoWidth: 640 })).toBe(false)
  })

  it('readyState 1(只有 metadata):還沒有當前影格,不算有影', () => {
    // 這是最容易誤判的一格:metadata 已經在了(所以寬度也知道),但影格還沒來。
    // 只看 videoWidth 的實作會在這裡說「有影」,然後收掉逾時,然後使用者
    // 就永遠卡住。
    expect(isCameraDeliveringFrames({ readyState: 1, videoWidth: 640 })).toBe(false)
  })

  it('readyState 2 且有寬度:真的有影', () => {
    expect(isCameraDeliveringFrames({ readyState: 2, videoWidth: 640 })).toBe(true)
  })

  it('readyState 4 但寬度是 0:track 連上了可是還沒有可用的畫面,不算有影', () => {
    // 反方向也要守住:只判 readyState 的實作會在這裡誤判成「相機正常」。
    expect(isCameraDeliveringFrames({ readyState: 4, videoWidth: 0 })).toBe(false)
  })

  it('headless 的假攝影機:readyState 0 + 寬度 0 → 不算有影(逾時該觸發)', () => {
    // 這一條就是效果稽核在 headless 量到的狀態。按下去之後逾時必須真的
    // 觸發並把相機收掉, 而不是讓使用者停在一個永遠不會變的畫面上。
    expect(isCameraDeliveringFrames({ readyState: 0, videoWidth: 0 })).toBe(false)
  })
})

describe('CAMERA_FIRST_FRAME_TIMEOUT_MS', () => {
  it('逾時必須寬到容得下慢速相機,但窄到使用者會以為壞掉', () => {
    // 實測:冷啟動最慢的筆電 webcam 約 2 秒出第一格。這裡用一個
    // 「明顯比最壞情況寬鬆、但明顯短於人類開始懷疑的時間」的區間來釘住,
    // 而不是斷言一個魔術數字。
    expect(CAMERA_FIRST_FRAME_TIMEOUT_MS).toBeGreaterThan(2_000)
    expect(CAMERA_FIRST_FRAME_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
  })
})

describe('gazeOffsetDeg 凝視偏移角(DESIGN_RESEARCH P0-1)', () => {
  it('px → cm 走 96dpi 假設(與 visualAngleDeg 同一套,兩處必須一起變)', () => {
    expect(pxToCm96dpi(96)).toBeCloseTo(2.54, 5)
    expect(pxToCm96dpi(0)).toBe(0)
  })

  it('錨點幾何的實際數字:65px @50cm ≈ 2.0°(與「鏡頭下方 ~2°」的宣稱一致)', () => {
    // 65px = LENS_BAND_TOP_PX 的視窗內偏移 + 錨點貼在螢幕上緣的極限情況。
    // 96dpi 下 65px = 1.72cm;atan(1.72/50) ≈ 1.97°。
    expect(gazeOffsetDeg(65, 50)).toBeCloseTo(1.97, 1)
    // 舊寬 420 時 band 頂緣在 42px —— 一併釘住兩個設計點的角度。
    expect(gazeOffsetDeg(42, 50)).toBeCloseTo(1.27, 1)
  })

  it('隨偏移單調遞增(角度是距離的單調函數,沒有哪一段會「越遠越小」)', () => {
    let prev = -1
    for (const px of [0, 10, 42, 65, 130, 400]) {
      const deg = gazeOffsetDeg(px, 50)
      expect(deg).toBeGreaterThanOrEqual(prev)
      prev = deg
    }
  })

  it('防呆:距離 0 / NaN / 負偏移都回 0,不回 NaN(設定頁不能印出 NaN°)', () => {
    expect(gazeOffsetDeg(65, 0)).toBe(0)
    expect(gazeOffsetDeg(65, Number.NaN)).toBe(0)
    expect(gazeOffsetDeg(Number.NaN, 50)).toBe(0)
    expect(gazeOffsetDeg(-65, 50)).toBe(0)
  })

  it('臉距越遠角度越小(同一段畫面距離,坐遠一點眼睛偏得更少)', () => {
    expect(gazeOffsetDeg(65, 70)).toBeLessThan(gazeOffsetDeg(65, 50))
  })
})
