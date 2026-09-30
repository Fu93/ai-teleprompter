/**
 * glassRefraction.ts — Liquid Glass 真折射(POLISH_RESEARCH P2-13)
 *
 * 原理(kube.io Liquid Glass in the Browser):
 * 1. 以 squircle 表面函數 y = (1-(1-x)^4)^(1/4) 對玻璃邊框(bezel)做光線折射模擬
 * 2. 把位移向量場編碼成 RGBA 圖:R = X 位移、G = Y 位移、128 = 中性(不動)
 * 3. <feImage> 載入位移圖 + <feDisplacementMap> 套在 backdrop-filter 上,
 *    背景內容在邊框處被「折射」彎曲 — 這是 blur 玻璃沒有的真折射感
 *
 * Chromium-only(SVG filter 作為 backdrop-filter 非規格行為);
 * CSS 端以 @supports 規則讓不支援的引擎自動退回一般 blur 玻璃,零 JavaScript 偵測。
 *
 * 全部為純函數,可在 node 測試環境驗證數學。
 */

/** squircle 表面高度:0=外緣,1=邊框結束(平面開始) */
export function squircleSurface(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return Math.pow(1 - Math.pow(1 - t, 4), 0.25)
}

/**
 * 單一光線的折射位移量(以玻璃厚度 IOR 1.5、單次折射簡化):
 * 入射角由表面法線(squircle 導數)推得,斯涅爾定律折射後的水平位移。
 * 回傳正規化位移(0=不動,1=最大),方向一律指向內部(凸面匯聚)。
 */
export function rayDisplacement(distanceFromEdge01: number): number {
  if (!Number.isFinite(distanceFromEdge01)) return 0
  const x = Math.min(1, Math.max(0, distanceFromEdge01))
  const delta = 0.001
  const y1 = squircleSurface(Math.max(0, x - delta))
  const y2 = squircleSurface(Math.min(1, x + delta))
  const slope = (y2 - y1) / (2 * delta)
  // 凸面:法線朝外傾斜,折射光線向內彎;位移與斜率同向,在邊框中段最大
  // 以 |slope| 的飽和近似代替完整 Snell 疊代(視覺等效,計算量小 3 個數量級)
  const magnitude = Math.min(1, Math.abs(slope) * 0.5)
  // 邊緣(0)與平面交點(1)位移為 0,中段峰值
  const falloff = Math.sin(Math.PI * x)
  return magnitude * falloff
}

/** 形狀內縮距離與內向法線 */
export interface ShapeInset {
  /** 由邊界往內的距離(px)。負值 = 在形狀外 */
  depth: number
  /** 內向法線(單位向量,指向形狀內部) */
  nx: number
  ny: number
}

/**
 * 圓角矩形(含膠囊)的 signed distance 與內向法線。
 *
 * 為什麼不是「到四條直邊的最近距離」:那是上一版的模型,它在圓端與直邊的交界
 * 有接縫(靠一個 bezel*0.5 的 lerp 硬補),而膠囊整個輪廓都是圓弧 —— 接縫會讓
 * 折射在上下兩條直邊上堆出一段亮帶,外觀就是「一個有白邊的長方形框」而不是
 * 橢圓環。SDF 用同一個式子描述直邊與圓端,法線沿周長連續,膠囊的兩端
 * (radius = height/2)會自動得到徑向對稱的環。
 *
 * 座標以像素中心為準(px+0.5);radius 會被夾在 [0, min(w,h)/2]。
 */
export function shapeInset(
  px: number,
  py: number,
  width: number,
  height: number,
  radius: number
): ShapeInset {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  const cx = width / 2
  const cy = height / 2
  const dx = px + 0.5 - cx
  const dy = py + 0.5 - cy
  // 圓角矩形 SDF:q = |p-c| - (half - r),d = |max(q,0)| + min(max(q),0) - r
  const qx = Math.abs(dx) - (width / 2 - r)
  const qy = Math.abs(dy) - (height / 2 - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  const outside = Math.hypot(ax, ay)
  const sdf = outside + Math.min(Math.max(qx, qy), 0) - r

  // 外向法線(梯度);outside > 0 = 在圓角區,方向由兩個軸合成
  let gx = 0
  let gy = 0
  if (outside > 1e-6) {
    gx = Math.sign(dx) * (ax / outside)
    gy = Math.sign(dy) * (ay / outside)
  } else if (qx > qy) {
    gx = Math.sign(dx)
  } else {
    gy = Math.sign(dy)
  }
  const len = Math.hypot(gx, gy) || 1
  return { depth: -sdf, nx: -gx / len, ny: -gy / len }
}

export interface DisplacementMapResult {
  /** PNG data URL,交給 <feImage href> */
  dataUrl: string
  /** 最大位移(px),即 <feDisplacementMap scale>;位移圖已正規化到 1 */
  maxDisplacementPx: number
  width: number
  height: number
}

/**
 * 產生容器的位移圖。
 * 邊框中每個像素的位移向量 = 該點 SDF 的內向法線(見 shapeInset),量值由
 * rayDisplacement 決定。法線來自真實的形狀距離場,所以膠囊的折射環是連續的
 * 橢圓環,而不是「直邊一段 + 圓端一段」拼起來的框。
 *
 * bezelPx / maxDisplacementPx 應隨形狀半徑縮放(呼叫端:bezel ≈ radius*0.55);
 * 對 48px 高的藥丸而言固定 18/14 等於把位移推到整條直邊上,那是「長方形感」
 * 的另一半來源。
 */
export function buildDisplacementMap(
  width: number,
  height: number,
  radius: number,
  bezelPx: number,
  maxDisplacementPx: number
): DisplacementMapResult {
  const bezel = Math.max(2, Math.round(bezelPx))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return { dataUrl: '', maxDisplacementPx, width, height }

  const img = ctx.createImageData(width, height)
  const data = img.data

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = (py * width + px) * 4
      const { depth, nx, ny } = shapeInset(px, py, width, height, radius)

      let mag = 0
      if (depth >= 0 && depth <= bezel) {
        mag = rayDisplacement(depth / bezel)
      }

      const rx = mag > 0 ? Math.round(128 + nx * mag * 127) : 128
      const gy = mag > 0 ? Math.round(128 + ny * mag * 127) : 128
      data[idx] = rx
      data[idx + 1] = gy
      data[idx + 2] = 128 // B 不用
      data[idx + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return { dataUrl: canvas.toDataURL(), maxDisplacementPx, width, height }
}

/**
 * 產生完整的 <filter> 元素並掛到 document(冪等:同 id 重複呼叫只更新)。
 * 回傳 filter id,供 CSS `backdrop-filter: url(#id)`。
 */
export function ensureGlassFilter(
  id: string,
  map: DisplacementMapResult,
  blurPx = 2
): string {
  let svg = document.getElementById(id) as unknown as SVGSVGElement | null
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.id = id
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    document.body.appendChild(svg)
  }
  svg.setAttribute('color-interpolation-filters', 'sRGB')
  svg.innerHTML = `
    <filter id="${id}-f" x="0" y="0" width="${map.width}" height="${map.height}" filterUnits="userSpaceOnUse">
      <feImage href="${map.dataUrl}" x="0" y="0" width="${map.width}" height="${map.height}" result="map" />
      <feGaussianBlur in="SourceGraphic" stdDeviation="${blurPx}" result="blurred" />
      <feDisplacementMap in="blurred" in2="map" scale="${map.maxDisplacementPx}"
        xChannelSelector="R" yChannelSelector="G" />
    </filter>`
  return `${id}-f`
}
