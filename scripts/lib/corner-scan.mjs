/**
 * corner-scan.mjs — 四角幾何量測(由 audit-glass-edge.mjs 使用)。
 *
 * 量測:從每個角沿 45° 對角線往內掃,找第一個「材質」像素的距離,
 * 與圓角的解析解比對:d = r × (1 − 1/√2) ≈ 0.293 r(對角線與半徑 r 的
 * 圓弧交點到角的距離)。
 *
 * 為什麼理論值從元素**宣告的**半徑算:斷言的意義是「像素 honors 宣告」,
 * 不是「像素等於某個數字」。宣告改了(例如 rounded-2xl → 28px),這裡
 * 自動跟著新值驗;寫死才會在合法改版時假紅。
 *
 * 為什麼背景取四角中位數:圓角正確時四角全是桌布 → bg 就是桌布色;
 * 角是方形時四角全是材質 → bg 變材質色、對角線掃不到對比 → first = -1。
 * 兩種情況都會讓斷言失敗,不會誤判成通過。
 *
 * 這個函式是純像素運算(不啟動 Electron),抽出來是為了讓負向驗證可以用
 * 合成的 PNG 直接跑,不必為了驗證量測端而啟動整個 App。
 */

/** 與背景亮度差超過這個級數才算「材質」。只用在白桌布截圖:深玻璃(≈64)
 *  vs 255 對比充裕;深色桌布上兩者都 ≈ 11–13,判定在那裡天生無效。 */
export const CORNER_CONTRAST = 40

/** 對角首材質距離的容許誤差(device px):antialias + rim 暗環 + 折射合計
 *  1–2px,4 的餘裕仍能抓住「角被填成方形」(實測方角首材質 ≤ 2px)與
 *  「半徑對半縮水」(7 vs 14)。它抓的是幾何失效(Electron #43075 那類
 *  視窗層吃掉圓角),不是驗半徑到次像素。 */
export const CORNER_TOL_PX = 4

/**
 * 掃描截圖的四個角。
 *
 * @param {string} path 截圖路徑(PNG),必須剛好是表面的 bounding box
 * @param {{w: number, h: number}} box 表面的 CSS px 尺寸(用來推 dpr)
 * @param {number} radiusCss 元素宣告的圓角半徑(CSS px;rounded-full 的
 *        9999px 會先按 CSS 規則夾到 min(w,h)/2)
 * @returns {Promise<{theory: number, firsts: number[], cornerLums: number[],
 *          bg: number, matched: number, pass: boolean}>}
 */
export async function cornerScan(path, box, radiusCss) {
  const { default: sharp } = await import('sharp')
  const { width, height } = await sharp(path).metadata()
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
  const ch = info.channels
  const lum = (x, y) => {
    const i = (y * width + x) * ch
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }
  const c00 = Math.round(lum(0, 0))
  const c10 = Math.round(lum(width - 1, 0))
  const c01 = Math.round(lum(0, height - 1))
  const c11 = Math.round(lum(width - 1, height - 1))
  const sorted = [c00, c10, c01, c11].sort((a, b) => a - b)
  const bg = (sorted[1] + sorted[2]) / 2
  const probe = (cx, cy, dx, dy) => {
    const limit = Math.floor(Math.min(width, height) / 3)
    for (let d = 0; d < limit; d++) {
      const x = Math.min(width - 1, cx + dx * d)
      const y = Math.min(height - 1, cy + dy * d)
      if (Math.abs(lum(x, y) - bg) > CORNER_CONTRAST) return d
    }
    return -1
  }
  const firsts = [
    probe(0, 0, 1, 1),
    probe(width - 1, 0, -1, 1),
    probe(0, height - 1, 1, -1),
    probe(width - 1, height - 1, -1, -1)
  ]
  // 截圖是 device px、box 是 CSS px:dpr 從兩者比例推出,不依賴 window.devicePixelRatio
  const dpr = width / Math.max(1, box.w)
  // 宣告半徑照 CSS 規則先夾到 min(w,h)/2(rounded-full 的 9999px 在這裡變 h/2);
  // 對稱等值半徑不會觸發相鄰角和的二次夾取,膠囊與面板都不受影響。
  const rCss = Math.min(radiusCss, Math.min(box.w, box.h) / 2)
  const theory = rCss * (1 - 1 / Math.SQRT2) * dpr
  const matched = firsts.filter((d) => Math.abs(d - theory) <= CORNER_TOL_PX).length
  return {
    theory: Math.round(theory * 10) / 10,
    firsts,
    cornerLums: [c00, c10, c01, c11],
    bg: Math.round(bg),
    matched,
    pass: matched === 4
  }
}
