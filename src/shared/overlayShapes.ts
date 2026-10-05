/**
 * overlayShapes.ts — 浮層三形態的尺寸契約（單一來源）。
 *
 * 為什麼要放在 shared:
 *   這組數字有兩個必須一致的消費者 —— renderer 的 morph 動畫（要長成多大）與
 *   main 的視窗最小尺寸（不准被縮到比形態需求更小）。寫成兩份就一定會漂移，
 *   而漂移的症狀正是這輪修掉的那個 bug:視窗被允許縮到 280×40，但藥丸的內容
 *   需要約 300px、貼鏡需要 420×170 —— 於是最後一顆按鈕（展開鈕，也是藥丸唯一
 *   的出口）被 overflow 裁掉，貼鏡的正文整段消失。
 *
 * 為什麼「每個形態各自有下限」而不是統一個 280×40:
 *   280×40 是「展開形態」的需求（使用者可以自己拖到很小的長條）。藥丸與貼鏡
 *   是我們自己算出來的固定版面，讓視窗小於它們需要的尺寸沒有任何人受益 ——
 *   只會製造出一個內容對不上視窗的狀態。
 *
 * 為什麼藥丸還需要一個「倍率」:
 *   島的大小是「螢幕大小 / DPI / 視力 / 桌面留白」的問題，不是美感偏好 ——
 *   1080p 與 4K、筆電與大螢幕需要的大小本來就不同。與其由我們在原始碼裡替
 *   所有人決定一個常數，不如給一個有界範圍（0.8×–1.3×）讓使用者在設定頁調，
 *   並用「內容需求」夾住下限，任何倍率下都不會有人被裁掉。
 *   倍率只縮放膠囊本體:字級與 28px 的按鈕不動 —— 縮小觸控目標是無障礙問題，
 *   不是「等比例縮小」可以帶過的。
 */

/**
 * 藥丸（compact）在 1.00× 的設計尺寸。
 *
 * 為什麼是 320×48:靈動島的「島感」幾乎全部來自比例與留白 —— 真島約 3.4:1，
 * 而 460×56 是 8.2:1，讀起來是「一條狀態列 / 通知條」，不是島。
 * 48 這個高度則讓 border-radius = h/2 = 24 → 真正的體育場形（橢圓端），
 * 這是「讀成橢圓而不是圓角長方形」的硬條件（稽核會斷言 radius ≥ h/2）。
 *
 * 寬度 320 不是美感值，是下面 PILL_BUDGET 算出來的：核心 208 + 跟讀音柱 21
 * + 「下一個關鍵詞」 74 = 303，320 留約 17px 餘裕給中文字寬差異與 DPI。
 */
export const PILL_BASE = { w: 320, h: 48 } as const

/** 藥丸在 1.00× 的最小尺寸（展開鈕永不被裁掉的那條線） */
export const PILL_MIN_BASE = { w: 260, h: 48 } as const

/** 藥丸倍率的可調範圍與步進（設定頁滑桿與夾取共用同一組定義） */
export const PILL_SCALE_MIN = 0.8
export const PILL_SCALE_MAX = 1.3
export const PILL_SCALE_STEP = 0.05

/**
 * 藥丸列的寬度預算（px）。數字全部對應 OverlayApp 藥丸列的實際 class，不是估的。
 *
 * 這份清單是「藥丸唯一的出口是展開鈕」這件事的量化形式：只要三顆按鈕
 * （救援 / 暫停 / 展開）都放得下，其餘都可以降級；放不下就必須讓視窗變寬，
 * 而不是讓展開鈕被裁掉 —— 使用者會看到一顆按不到的按鈕，且沒有任何線索說它在那裡。
 */
export const PILL_BUDGET = {
  /** px-3.5 兩側 */
  padding: 28,
  /** gap-2。根層三個（層↔鈕、鈕↔鈕、鈕↔鈕），內容層的 gap 另外算 */
  gap: 8,
  /** h-2 w-2 的狀態點 */
  statusDot: 8,
  /** min-w-[3.5rem]，8 個中文字的標題下限 */
  titleMin: 56,
  /** 跟讀中的三根音柱（只在 followStatus==='listening' 時存在） */
  voiceBars: 13,
  /** h-7 w-7 ×3:救援 / 暫停 / 展開 */
  button: 28,
  buttonCount: 3,
  /**
   * 「下一個關鍵詞」:degrade(next, 6) 的六個中文字 @ text-[11px]。
   * 它是 shrink-0 whitespace-nowrap —— 不會自己變小，所以寬度不夠時
   * 必須由這裡主動不放，而不是讓它去擠掉同樣 shrink-0 的展開鈕。
   */
  keyword: 87
} as const

/**
 * 關鍵詞每個中文字的實測寬度(text-[11px],Noto Sans TC)。
 * 由「六個字 = 87px」推出;稽核的 overlay.pill.Nx.loaded note 每次都會記下實寬,
 * 換字體時這個數字要跟著量。
 */
export const PILL_KEYWORD_CHAR_W = 14.5

/** 關鍵詞的字數上限:再多就會把「提示下一句」變成雜訊 */
export const PILL_KEYWORD_MAX_CHARS = 6

/**
 * 內容層裡「不含關鍵詞」的部分:狀態點 + 標題下限 + 跟讀音柱 + 三個間距。
 * 由稽核實測的段落清單加總(8 + 56 + 13 + 8×3 = 101)。
 */
export const PILL_ROW_BASE_W =
  PILL_BUDGET.statusDot +
  PILL_BUDGET.titleMin +
  PILL_BUDGET.voiceBars +
  PILL_BUDGET.gap * 3

/** 核心寬度需求（狀態點 + 標題 + 三顆按鈕 + padding + gap）≈ 208 */
export const PILL_CORE_W =
  PILL_BUDGET.padding +
  PILL_BUDGET.gap * 3 +
  PILL_BUDGET.statusDot +
  PILL_BUDGET.gap +
  PILL_BUDGET.titleMin +
  PILL_BUDGET.button * PILL_BUDGET.buttonCount

/** 核心 + 跟讀音柱 ≈ 229 */
export const PILL_WITH_BARS_W = PILL_CORE_W + PILL_BUDGET.gap + PILL_BUDGET.voiceBars

/** 核心 + 跟讀音柱 + 「下一個關鍵詞」≈ 303 */
export const PILL_WITH_KEYWORD_W =
  PILL_WITH_BARS_W + PILL_BUDGET.gap + PILL_KEYWORD_MAX_CHARS * PILL_KEYWORD_CHAR_W

/**
 * 藥丸在任何倍率下都必須容得下的寬度（內容預算，不隨倍率打折）。
 *
 * 夾在「核心 + 跟讀音柱」(229) 上，而不是等比縮出來的值：0.8× 時
 * 260×0.8 = 208 只夠核心，音柱與關鍵詞都放不下。三顆按鈕仍放得下，
 * 這才是這條線存在的唯一理由。
 */
const PILL_CONTENT_MIN_W = 232

/** 這個倍率下的視窗還塞得下哪些可選段落。降級順序固定：先關鍵詞，再音柱。 */
export interface PillFit {
  /** 跟讀音柱放得下（第二個讓位的） */
  voiceBars: boolean
  /** 「下一個關鍵詞」放得下（第一個讓位的） */
  keyword: boolean
}

/**
 * 依實際視窗寬度決定藥丸列的降級層級。
 *
 * 為什麼用「視窗寬」而不是「設計寬 × 0.94」:藥丸的視窗可以被使用者拖到比設計寬更小
 * （下限由 pillMinOf 決定，1.00× 是 260 < 設計 320），用設計寬當門檻時，
 * 視窗已經不夠寬了而關鍵詞還在 —— 而它是 shrink-0，於是被它擠掉的是同樣 shrink-0
 * 的展開鈕。症狀是「藥丸沒有出口」，而使用者看不出有東西被裁掉。
 */
export function pillFitOf(scale: number, winW: number): PillFit {
  void scale // 門檻只跟內容有關;倍率改變的是設計寬與下限,不是各段落的寬度
  return {
    voiceBars: winW >= PILL_WITH_BARS_W,
    keyword: pillKeywordCharsOf(winW) >= 1
  }
}

/**
 * 這個視窗寬度下,「下一個關鍵詞」還能放幾個字(0 = 整段不渲染)。
 *
 * 為什麼是「縮字數」而不是「整個藏起來」:實測顯示 1.00× 的設計寬 320 裝不下六個字
 * (完整內容需要 324),但裝得下五個。只用二元的顯示/隱藏,會讓 0.8× 到 1.3× 之間
 * **全部**失去這個功能 —— 連預設的 1.00× 也沒有。那是一個沒有必要的損失。
 * 正確的降級方向是「資訊變粗略」而不是「資訊消失」:三個字仍然看得出下一句開頭,
 * 而展開鈕(藥丸唯一的出口)永遠完整。
 *
 * 這個函式取代了原本「拿設計寬乘 0.94」那條門檻:後者與寬度預算無關,所以
 * 視窗一旦比設計寬窄就會失準(而窄視窗正是內容被擠爆的時候)。
 */
export function pillKeywordCharsOf(winW: number): number {
  const rowFree = winW - PILL_ROW_BASE_W - PILL_BUDGET.padding - PILL_BUDGET.gap * 3 - PILL_BUDGET.button * PILL_BUDGET.buttonCount
  if (rowFree < PILL_KEYWORD_CHAR_W) return 0
  return Math.min(PILL_KEYWORD_MAX_CHARS, Math.floor(rowFree / PILL_KEYWORD_CHAR_W))
}

/** 把任意輸入（設定檔、IPC、滑桿）夾成合法的藥丸倍率 */
export function clampPillScale(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1
  const stepped = Math.round(n / PILL_SCALE_STEP) * PILL_SCALE_STEP
  const clamped = Math.min(PILL_SCALE_MAX, Math.max(PILL_SCALE_MIN, stepped))
  return Math.round(clamped * 100) / 100
}

/** 某倍率下的藥丸設計尺寸（寬高等比；半徑永遠是高度的一半 = 真膠囊） */
export function pillSizeOf(scale: number): { w: number; h: number } {
  const s = clampPillScale(scale)
  return { w: Math.round(PILL_BASE.w * s), h: Math.round(PILL_BASE.h * s) }
}

/** 某倍率下的藥丸最小尺寸（寬度另有內容需求的下限） */
export function pillMinOf(scale: number): { w: number; h: number } {
  const s = clampPillScale(scale)
  return {
    // 高度不夾:28px 的按鈕在 38px 的列裡還放得下,再往上夾只會讓 0.8× 的滑桿
    // 在高度方向變成空行程(視窗高度下限 38 < pillSizeOf(0.8).h 也是 38,已一致)
    w: Math.max(PILL_CONTENT_MIN_W, Math.round(PILL_MIN_BASE.w * s)),
    h: Math.round(PILL_MIN_BASE.h * s)
  }
}

/** 貼鏡（lens）的設計尺寸 */
export const LENS_SIZE = { w: 420, h: 170 } as const

/** 展開形態的最小尺寸（使用者可以拖曳到這麼小） */
export const EXPANDED_MIN = { w: 280, h: 40 } as const

/** 1.00× 的藥丸尺寸（相容常數:稽核腳本與既有呼叫端用得到） */
export const PILL_SIZE = PILL_BASE

/** 1.00× 的藥丸最小尺寸（相容常數） */
export const PILL_MIN = PILL_MIN_BASE

/** 貼鏡的最小尺寸就是它的設計尺寸:170 已經是「扣掉工具列與底部提示後的正文下限」。 */
export const LENS_MIN = { w: LENS_SIZE.w, h: LENS_SIZE.h } as const

/** 展開態工具列高度(OverlayApp 頂列的 `h-9`;牆上的一個數字,只在這條預算裡出現一次) */
export const OVERLAY_TOOLBAR_H = 36
/** 底部回饋堆疊離視窗底邊的距離(OverlayApp 的 `bottom-4`) */
export const OVERLAY_STACK_BOTTOM = 16
/**
 * 瞬時節奏讀數 chip 的實測高度。
 *
 * 來源不是估算:audit-deep 的 `overlay.pace.geometry` 在 720x260 的展開態量到
 * `115x25`(`py-1` + `text-[11px]` + 11px 圖示)。改動 chip 的內距或字級時,
 * 這個數字要跟著重量一次 —— 而稽核會在門檻附近直接報出來。
 */
export const PACE_READOUT_H = 25
/**
 * 放得下底部讀數的最小展開態高度(36 + 16 + 25 = 77px)。
 *
 * 為什麼需要它:讀數 chip 是絕對定位在視窗底部的**持續型**元件 —— 它不像
 * turn-yield / coaching 提示會自己退場("暫態貼到東西上"可以接受,因為它
 * 幾秒後就不見了)。而展開形態的最小高度是 EXPANDED_MIN.h = 40px,比 77 還小:
 * 使用者把浮層拖到最小、又剛好在講話時,chip 會**永久**蓋住工具列的前幾顆
 * 按鈕(它 pointer-events-none,點得到,但看不到自己在點什麼)。
 *
 * 所以門檻的方向是「沒有空間就不畫」—— 與藥丸/貼鏡不放讀數是同一個決定:
 * 讀數是「看著自己」的資訊,工具列是「操作提詞機」的入口,後者不能被蓋掉。
 */
export const PACE_READOUT_MIN_H = OVERLAY_TOOLBAR_H + OVERLAY_STACK_BOTTOM + PACE_READOUT_H

/** 這個視窗高度放得下底部讀數嗎?不夠就不畫(見 PACE_READOUT_MIN_H 的理由)。 */
export function paceReadoutFits(winH: number): boolean {
  return Number.isFinite(winH) && winH >= PACE_READOUT_MIN_H
}

export type OverlayShape = 'expanded' | 'pill' | 'lens'

/** 由設定的兩個旗標決定形態。判斷順序必須與 OverlayApp 的渲染順序一致（compact 優先）。 */
export function overlayShapeOf(o: { compact: boolean; lensMode: boolean }): OverlayShape {
  if (o.compact) return 'pill'
  if (o.lensMode) return 'lens'
  return 'expanded'
}

/**
 * 該形態宣告的最小視窗尺寸（DIP）。
 *
 * 藥丸的下限跟著 pillScale 走:main 端的 setMinimumSize 與 renderer 的 morph 目標
 * 必須用同一個倍率算，否則「使用者把藥丸調大」會變成「下限還停在 1.00× 的 260」。
 */
export function overlayShapeMin(o: {
  compact: boolean
  lensMode: boolean
  pillScale?: number
}): { w: number; h: number } {
  switch (overlayShapeOf(o)) {
    case 'pill': {
      const m = pillMinOf(o.pillScale ?? 1)
      return { w: m.w, h: m.h }
    }
    case 'lens':
      return { w: LENS_MIN.w, h: LENS_MIN.h }
    default:
      return { w: EXPANDED_MIN.w, h: EXPANDED_MIN.h }
  }
}

/** 該形態的「設計尺寸」:展開形態沒有設計值（只能用使用者存的寬高），所以回傳 null。 */
export function overlayShapeDesignSize(o: {
  compact: boolean
  lensMode: boolean
  pillScale?: number
}): { w: number; h: number } | null {
  switch (overlayShapeOf(o)) {
    case 'pill':
      return pillSizeOf(o.pillScale ?? 1)
    case 'lens':
      return { w: LENS_SIZE.w, h: LENS_SIZE.h }
    default:
      return null
  }
}
