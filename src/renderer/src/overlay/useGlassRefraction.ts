import { useCallback, useEffect, useRef, useState } from 'react'
import { buildDisplacementMap, ensureGlassFilter } from '../lib/glassRefraction'

export interface UseGlassRefractionResult {
  /** 引擎支援 SVG backdrop-filter 且 glass 開啟(CSS 端 @supports 再降級一次) */
  refractOk: boolean
  /** pill 外殼 ref */
  specRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Liquid Glass 真折射:位移圖隨視窗尺寸與**形狀**重建,filter 注入 DOM。
 * CSS 端 @supports 讓不支援 SVG backdrop-filter 的引擎自動退回一般 blur。
 *
 * 原本這裡還管「隨游標 specular 高光」(mousemove 寫 --spec-x/--spec-y/--spec-o)。
 * 已移除:那層是 cursor-following 的白色徑向漸層,預設位置在上緣,
 * 與先前 dynamic-island 光暈屬於同一種失敗型態(峰值落在視窗邊界像素)。
 * 雖然逐像素實測後確認它並沒有真的貼邊發光(+0.0 貢獻),但它在四層裝飾裡
 * 既不增加任何資訊量、又是唯一需要 JS 監聽滑鼠的層,只增加複雜度與風險。
 * 輪廓改由 CSS 的方向性 rim light 表達,不跟游標。
 *
 * morphing 參數:morph 途中位移圖與實際尺寸/半徑不一致(filterUnits 是
 * userSpaceOnUse,圖是以舊尺寸快取的),那段時間折射會把背景往錯的方向推 ——
 * 看起來就是一瞬間的扭曲。所以 morph 期間呼叫端不掛 .glass-refract,
 * 收斂後立刻重建一次再掛回去(不是只靠 300ms 的 resize debounce)。
 */
export function useGlassRefraction(
  glassOn: boolean,
  morphing = false
): UseGlassRefractionResult {
  const [refractOk, setRefractOk] = useState(false)
  const [winSize, setWinSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    // 偵測:Chromium 才允許 url() 於 backdrop-filter;以 CSS.supports 探測
    setRefractOk(
      typeof CSS !== 'undefined' &&
        (CSS.supports('backdrop-filter', 'url(#x)') || CSS.supports('-webkit-backdrop-filter', 'url(#x)'))
    )
  }, [])

  const rebuild = useCallback((): void => {
    const w = Math.max(1, window.innerWidth)
    const h = Math.max(1, window.innerHeight)
    // 折射半徑跟隨形態:藥丸是 rounded-full(半徑 = 高的一半,320×48 時為 24)、
    // 展開/貼鏡是 .overlay-radius(20px,見 global.css 的註解)。用 data 屬性而不是
    // class 名稱,三個形態都認得。
    const surface = document.querySelector('[data-overlay-surface]')
    const kind = surface?.getAttribute('data-overlay-surface')
    const radius = kind === 'pill' ? Math.round(h / 2) : 20
    // 參數隨半徑縮放(比例,不是常數):
    //  - 藥丸 48px 高 → bezel 13 / 位移 10;展開 20px 圓角 → bezel 11 / 位移 9。
    //  - 舊版固定 18/14,對 48px 高的膠囊等於把位移推到整條上下直邊上,
    //    外觀就是「裡面一個發亮的長方形框」—— 與 SDF 幾何的接縫是同一個症狀。
    // 過程記錄(同一個指標坑了兩次):
    //  1. 趁著拿掉邊框把參數從 14/12 拉到 20/18,想讓折射成為唯一輪廓來源。
    //  2. 深色桌布驗不出一問題,但純白桌布下「藥丸左右邊 190/255」看似爆表,
    //     於是把折射調保守到 15/9 —— 結果只動到 187,等於沒動。
    //  3. 才發現指標本身是壞的:那個數字來自整欄平均,而膠囊最左/最右欄
    //     的大部分高度在形狀之外,量到的是背景而不是玻璃邊緣(見
    //     scripts/audit-glass-edge.mjs 的註解)。
    //  4. 量測改成沿邊界法線取樣後,真正的邊緣行為是:純白桌布下
    //     邊緣比內部還暗(17.6 / 37.9),完全沒有白邊。
    const bezel = Math.max(6, Math.min(22, Math.round(radius * 0.55)))
    const disp = Math.max(3, Math.round(bezel * 0.8))
    const map = buildDisplacementMap(w, h, radius, bezel, disp)
    ensureGlassFilter('liquid-glass', map, 2.5)
    setWinSize({ w, h })
  }, [])

  useEffect(() => {
    if (!refractOk || !glassOn) return
    let timer: ReturnType<typeof setTimeout> | null = null
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
  }, [refractOk, glassOn, rebuild, winSize.w === 0])

  // morph 剛收斂:立刻以定案後的尺寸/半徑重建一次(不等 resize debounce)。
  const wasMorphingRef = useRef(false)
  useEffect(() => {
    if (!refractOk || !glassOn) return
    if (wasMorphingRef.current && !morphing) rebuild()
    wasMorphingRef.current = morphing
  }, [morphing, refractOk, glassOn, rebuild])

  // 保留 ref 外殼:OverlayApp 仍需要把藥丸元素掛上來(給折射半徑量測與拖曳用),
  // 但已不再監聽滑鼠。
  const specRef = useRef<HTMLDivElement | null>(null)

  return { refractOk, specRef }
}
