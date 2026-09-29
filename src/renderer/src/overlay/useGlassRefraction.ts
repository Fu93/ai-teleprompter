import { useEffect, useRef, useState } from 'react'
import { buildDisplacementMap, ensureGlassFilter } from '../lib/glassRefraction'

export interface UseGlassRefractionResult {
  /** 引擎支援 SVG backdrop-filter 且 glass 開啟(CSS 端 @supports 再降級一次) */
  refractOk: boolean
  /** pill 外殼 ref */
  specRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Liquid Glass 真折射:位移圖隨視窗尺寸重建,filter 注入 DOM。
 * CSS 端 @supports 讓不支援 SVG backdrop-filter 的引擎自動退回一般 blur。
 *
 * 原本這裡還管「隨游標 specular 高光」(mousemove 寫 --spec-x/--spec-y/--spec-o)。
 * 已移除:那層是 cursor-following 的白色徑向漸層,預設位置在上緣,
 * 與先前 dynamic-island 光暈屬於同一種失敗型態(峰值落在視窗邊界像素)。
 * 雖然逐像素實測後確認它並沒有真的貼邊發光(+0.0 貢獻),但它在四層裝飾裡
 * 既不增加任何資訊量、又是唯一需要 JS 監聽滑鼠的層,只增加複雜度與風險。
 * 輪廓改由 CSS 的方向性 rim light 表達,不跟游標。
 */
export function useGlassRefraction(glassOn: boolean): UseGlassRefractionResult {
  const [refractOk, setRefractOk] = useState(false)
  const [winSize, setWinSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    // 偵測:Chromium 才允許 url() 於 backdrop-filter;以 CSS.supports 探測
    setRefractOk(
      typeof CSS !== 'undefined' &&
        (CSS.supports('backdrop-filter', 'url(#x)') || CSS.supports('-webkit-backdrop-filter', 'url(#x)'))
    )
  }, [])

  useEffect(() => {
    if (!refractOk || !glassOn) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const rebuild = (): void => {
      const w = Math.max(1, window.innerWidth)
      const h = Math.max(1, window.innerHeight)
      // 折射半徑跟隨形態:藥丸 rounded-full(半徑=高一半)、貼鏡/展開 rounded-2xl(16px)。
      // 寫死 18 會讓折射環不跟膠囊邊緣走,圓端產生錯位亮弧(即白邊來源之一)
      const pill = document.querySelector('.dynamic-island-pill')
      const radius = pill ? Math.round(h / 2) : 16
      // 折射參數:Liquid Glass 的「液態感」幾乎全部來自這裡。
      //
      // 過程記錄(同一個指標坑了兩次):
      //  1. 趁著拿掉邊框把參數從 14/12 拉到 20/18,想讓折射成為唯一輪廓來源。
      //  2. 深色桌布驗不出一問題,但純白桌布下「藥丸左右邊 190/255」看似爆表,
      //     於是把折射調保守到 15/9 —— 結果只動到 187,等於沒動。
      //  3. 才發現指標本身是壞的:那個數字來自整欄平均,而膠囊最左/最右欄
      //     的大部分高度在形狀之外,量到的是背景而不是玻璃邊緣(見
      //     scripts/audit-glass-edge.mjs 的註解)。兩個設計改動都是白改。
      //  4. 量測改成沿邊界法線取樣後,真正的邊緣行為是:純白桌布下
      //     邊緣比內部還暗(17.6 / 37.9),完全沒有白邊。
      // 所以這裡把折射調回偏液態的數值,而不是停在先前那個過度保守的值。
      const map = buildDisplacementMap(w, h, radius, 18, 14)
      ensureGlassFilter('liquid-glass', map, 2.5)
      setWinSize({ w, h })
    }
    rebuild()
    // morph 動畫期間每幀都 resize,debounce 300ms 後重建
    const onResize = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(rebuild, 300)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (timer) clearTimeout(timer)
    }
  }, [refractOk, glassOn, winSize.w === 0])

  // 保留 ref 外殼:OverlayApp 仍需要把藥丸元素掛上來(給折射半徑量測與拖曳用),
  // 但已不再監聽滑鼠。
  const specRef = useRef<HTMLDivElement | null>(null)

  return { refractOk, specRef }
}
