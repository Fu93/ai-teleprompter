import { describe, it, expect } from 'vitest'
import {
  clampPillScale,
  overlayShapeDesignSize,
  overlayShapeMin,
  pillFitOf,
  pillMinOf,
  pillSizeOf,
  PILL_BUDGET,
  PILL_CORE_W,
  PILL_KEYWORD_CHAR_W,
  PILL_KEYWORD_MAX_CHARS,
  PILL_SCALE_MAX,
  PILL_SCALE_MIN,
  PILL_SIZE,
  PILL_ROW_BASE_W,
  PILL_WITH_BARS_W,
  PILL_WITH_KEYWORD_W,
  pillKeywordCharsOf
} from '@shared/overlayShapes'

/**
 * 藥丸尺寸契約。這個模組是 renderer 的 morph 目標、main 的 setMinimumSize 與
 * 設定頁滑桿共用的唯一定義 —— 它錯了,症狀會是「藥丸被裁掉」或「下限比內容還小」,
 * 而那種缺陷在畫面上只表現為「最後一顆按鈕不見了」,不容易回推到數字上。
 */
describe('clampPillScale', () => {
  it('預設 1(undefined / NaN / 字串都不能讓版面壞掉)', () => {
    expect(clampPillScale(undefined)).toBe(1)
    expect(clampPillScale(Number.NaN)).toBe(1)
    expect(clampPillScale('1.2' as unknown)).toBe(1)
  })

  it('夾在 0.8–1.3 之間', () => {
    expect(clampPillScale(0.1)).toBe(PILL_SCALE_MIN)
    expect(clampPillScale(9)).toBe(PILL_SCALE_MAX)
    expect(clampPillScale(1.15)).toBe(1.15)
  })

  it('吸附到 0.05 的步進(滑桿與設定檔手改都會經過這裡)', () => {
    expect(clampPillScale(0.83)).toBe(0.85)
    expect(clampPillScale(1.27)).toBe(1.25)
    expect(clampPillScale(0.799)).toBe(0.8)
  })
})

describe('pillSizeOf', () => {
  it('1.00× 就是設計尺寸,且與相容常數一致', () => {
    expect(pillSizeOf(1)).toEqual({ w: 320, h: 48 })
    expect(pillSizeOf(1)).toEqual({ w: PILL_SIZE.w, h: PILL_SIZE.h })
  })

  it('寬高等比(半徑才會永遠是高度的一半 = 真膠囊)', () => {
    for (const scale of [0.8, 0.95, 1, 1.15, 1.3]) {
      const s = pillSizeOf(scale)
      expect(s.h).toBe(Math.round(48 * scale))
      expect(s.w).toBe(Math.round(320 * scale))
    }
  })

  it('兩端:0.8× = 256×38、1.3× = 416×62', () => {
    expect(pillSizeOf(0.8)).toEqual({ w: 256, h: 38 })
    expect(pillSizeOf(1.3)).toEqual({ w: 416, h: 62 })
  })
})

describe('pillMinOf', () => {
  it('1.00× 維持 260×48(與上一版的下限一致)', () => {
    expect(pillMinOf(1)).toEqual({ w: 260, h: 48 })
  })

  it('倍率變小時,寬度不會小於內容需求 232(展開鈕永不被裁掉)', () => {
    // 260×0.8 = 208 —— 那已經裝不下「狀態點 + 標題 + 三顆按鈕」,所以夾到 232
    expect(pillMinOf(0.8).w).toBe(232)
    expect(pillMinOf(0.8).h).toBe(38)
  })

  it('任何倍率下:下限都小於等於設計尺寸(否則視窗一開始就被夾住)', () => {
    for (const scale of [0.8, 0.85, 0.9, 1, 1.1, 1.2, 1.3]) {
      const design = pillSizeOf(scale)
      const min = pillMinOf(scale)
      expect(min.w).toBeLessThanOrEqual(design.w)
      expect(min.h).toBeLessThanOrEqual(design.h)
    }
  })
})

/**
 * 內容預算與降級層級。
 *
 * 這組測試是為了釘住一句話:「任何倍率下都不會有人被裁掉」。
 * 那句話在實作上只等價於一個不等式,所以就直接寫成不等式測試 ——
 * 註解寫「約 221」而 JSX 是 232 這種漂移,只有拿算式去斷才擋得住。
 */
describe('PILL_BUDGET 與降級層級', () => {
  it('預算加總與設計尺寸對得上(28+24+8+8+56+84 = 208)', () => {
    expect(PILL_BUDGET.padding).toBe(28) // px-3.5 兩側
    expect(PILL_BUDGET.buttonCount).toBe(3) // 救援 / 暫停 / 展開
    expect(PILL_BUDGET.button).toBe(28) // h-7 w-7
    expect(PILL_CORE_W).toBe(208)
    expect(PILL_WITH_BARS_W).toBe(229)
  })

  it('列基礎寬度 101 = 狀態點 8 + 標題下限 56 + 音柱 13 + 三個 gap', () => {
    expect(PILL_ROW_BASE_W).toBe(101)
  })

  /**
   * 這組數字全部來自稽核實測,不是估算。
   *
   * 為什麼要特別強調:第一版把關鍵詞記成 66px(六字 @ 11px),而實測是 87px。
   * 差 21px 讓「1.00× 的 320 裝得下完整內容」看起來成立,實際上滿載時溢出 4px ——
   * 也就是**預設倍率就有缺陷**,而當時的稽核完全看不到(它量的是空內容的藥丸)。
   */
  it('完整內容的實測寬度是 324,不是先前估算的 303', () => {
    expect(PILL_KEYWORD_CHAR_W).toBe(14.5) // 87 / 6
    expect(PILL_KEYWORD_MAX_CHARS).toBe(6)
    expect(PILL_BUDGET.keyword).toBe(87) // 六個字實寬
    expect(PILL_WITH_KEYWORD_W).toBe(324)
  })

  it('1.00× 的設計寬 320 裝不下滿載內容 —— 這是降級存在的原因', () => {
    expect(pillSizeOf(1).w).toBeLessThan(PILL_WITH_KEYWORD_W)
  })

  it('任何倍率下,視窗下限都裝得下「三顆按鈕 + 標題下限 + 音柱」(展開鈕不可被裁)', () => {
    for (const scale of [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.25, 1.3]) {
      expect(pillMinOf(scale).w).toBeGreaterThanOrEqual(PILL_WITH_BARS_W)
    }
  })

  /**
   * 字數預算:這是這一輪的核心修正。
   *
   * 修掉的是「0.8× 溢出 46px、1.00× 溢出 4px」——而後者是**預設倍率**。
   * 降級方式是縮字數而不是整個隱藏,否則 1.00×(裝得下五字)也會失去這個功能。
   */
  describe('pillKeywordCharsOf', () => {
    it('各倍率的設計寬推出來的字數(稽核實測一致)', () => {
      expect(pillKeywordCharsOf(pillSizeOf(0.8).w)).toBe(1) // 256
      expect(pillKeywordCharsOf(pillSizeOf(1).w)).toBe(5) // 320
      expect(pillKeywordCharsOf(pillSizeOf(1.3).w)).toBe(6) // 416
    })

    it('字數上限是 6,不會因為視窗很寬就變成雜訊', () => {
      expect(pillKeywordCharsOf(2000)).toBe(PILL_KEYWORD_MAX_CHARS)
    })

    it('放不下一個字就回傳 0(呼叫端整段不渲染)', () => {
      expect(pillKeywordCharsOf(0)).toBe(0)
      expect(pillKeywordCharsOf(PILL_WITH_BARS_W)).toBe(0)
    })

    it('單調不減:視窗變寬字數只會不變或變多', () => {
      let prev = -1
      for (let w = 0; w <= 500; w += 5) {
        const n = pillKeywordCharsOf(w)
        expect(n).toBeGreaterThanOrEqual(prev)
        prev = n
      }
    })

    /**
     * 真正的不變量:算出的字數一定放得下。
     * 稽核的 pill-content-overflow 就是在量這件事(內容層 scrollWidth vs clientWidth),
     * 這裡是它的純函式版本 —— 兩邊都對才叫修好。
     */
    it('任何倍率:核心 + 音柱 + 算出的字數,都不超過該倍率的設計寬度', () => {
      for (const scale of [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3]) {
        const design = pillSizeOf(scale).w
        const need = PILL_WITH_BARS_W + PILL_BUDGET.gap + pillKeywordCharsOf(design) * PILL_KEYWORD_CHAR_W
        expect(need).toBeLessThanOrEqual(design)
      }
    })
  })

  it('pillFitOf:0 字等於整段不渲染', () => {
    // 放得下一個字的最小寬度 = 核心+音柱(229) + 與關鍵詞的間距(8) + 一個字(14.5) = 251.5
    const oneCharMin = Math.ceil(PILL_WITH_BARS_W + PILL_BUDGET.gap + PILL_KEYWORD_CHAR_W)
    expect(oneCharMin).toBe(252)
    expect(pillFitOf(1, oneCharMin - 1).keyword).toBe(false)
    expect(pillFitOf(1, oneCharMin).keyword).toBe(true)
    expect(pillFitOf(1, 100).voiceBars).toBe(false)
    expect(pillFitOf(1, PILL_WITH_BARS_W).voiceBars).toBe(true)
  })

  it('倍率不影響降級門檻(各段落的寬度不隨倍率縮,縮的只有膠囊本體)', () => {
    for (const scale of [0.8, 1, 1.3]) {
      expect(pillFitOf(scale, 400)).toEqual({ voiceBars: true, keyword: true })
      expect(pillFitOf(scale, 100)).toEqual({ voiceBars: false, keyword: false })
    }
  })
})

describe('overlayShapeMin / overlayShapeDesignSize', () => {
  it('三形態各自的下限(藥丸吃 pillScale,預設 1)', () => {
    expect(overlayShapeMin({ compact: true, lensMode: false })).toEqual({ w: 260, h: 48 })
    expect(overlayShapeMin({ compact: true, lensMode: false, pillScale: 1.3 })).toEqual({
      w: 338,
      h: 62
    })
    expect(overlayShapeMin({ compact: false, lensMode: true })).toEqual({ w: 420, h: 170 })
    expect(overlayShapeMin({ compact: false, lensMode: false })).toEqual({ w: 280, h: 40 })
  })

  it('compact 優先於 lensMode(與 OverlayApp 的渲染順序一致)', () => {
    expect(overlayShapeMin({ compact: true, lensMode: true }).w).toBe(260)
  })

  it('設計尺寸:展開形態沒有設計值(只能用使用者存的寬高)', () => {
    expect(overlayShapeDesignSize({ compact: true, lensMode: false, pillScale: 0.8 })).toEqual({
      w: 256,
      h: 38
    })
    expect(overlayShapeDesignSize({ compact: false, lensMode: true })).toEqual({ w: 420, h: 170 })
    expect(overlayShapeDesignSize({ compact: false, lensMode: false })).toBeNull()
  })
})
