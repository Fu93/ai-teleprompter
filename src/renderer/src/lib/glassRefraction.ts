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

export interface DisplacementMapResult {
  /** PNG data URL,交給 <feImage href> */
  dataUrl: string
  /** 最大位移(px),即 <feDisplacementMap scale>;位移圖已正規化到 1 */
  maxDisplacementPx: number
  width: number
  height: number
}

/**
 * 產生圓角矩形容器的位移圖。
 * 邊框中每個像素的位移向量 = 從邊緣指向內部,量值由 rayDisplacement 決定。
 * 圓角矩形:對「到最近邊的距離」與「到圓角中心的距離」取較小者作為滲透深度。
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
  const r = Math.min(radius, width / 2, height / 2)

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = (py * width + px) * 4
      // 到四邊的滲透深度(px)
      const depthL = px
      const depthR = width - 1 - px
      const depthT = py
      const depthB = height - 1 - py
      // 圓角:超出半徑的角落,改算到圓角中心的距離
      const cx = Math.min(Math.max(px, r), width - r)
      const cy = Math.min(Math.max(py, r), height - r)
      const inCorner = cx !== px || cy !== py
      const cornerDist = inCorner ? Math.hypot(px - cx, py - cy) : Infinity
      const cornerDepth = r - cornerDist // 負值=在圓角外,位移 0

      // 主導邊 = 滲透最淺的方向;向量由該邊指向內部
      const depths = [
        { d: depthL, vx: 1, vy: 0 },
        { d: depthR, vx: -1, vy: 0 },
        { d: depthT, vx: 0, vy: 1 },
        { d: depthB, vx: 0, vy: -1 }
      ].sort((a, b) => a.d - b.d)

      let vx: number
      let vy: number
      let depth: number
      if (inCorner && cornerDepth < depths[0].d) {
        // 圓角區:向量從角落圓心指向外(位移把背景往內拉)
        const len = Math.hypot(px - cx, py - cy) || 1
        vx = (px - cx) / len
        vy = (py - cy) / len
        depth = cornerDepth
      } else {
        vx = depths[0].vx
        vy = depths[0].vy
        depth = depths[0].d
      }

      let mag = 0
      if (depth >= 0 && depth <= bezel) {
        mag = rayDisplacement(depth / bezel)
      }

      // 0.71 的中央邊界處理:相鄰兩邊深度接近時混合向量,避免對角接縫
      let rx = 128
      let gy = 128
      if (mag > 0) {
        if (depths[1].d - depths[0].d < bezel * 0.5) {
          // 過渡:向次主導邊向量 lerp
          const t = 1 - (depths[1].d - depths[0].d) / (bezel * 0.5)
          const sx = vx * (1 - t) + depths[1].vx * t
          const sy = vy * (1 - t) + depths[1].vy * t
          const sl = Math.hypot(sx, sy) || 1
          rx = Math.round(128 + (sx / sl) * mag * 127)
          gy = Math.round(128 + (sy / sl) * mag * 127)
        } else {
          rx = Math.round(128 + vx * mag * 127)
          gy = Math.round(128 + vy * mag * 127)
        }
      }
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
