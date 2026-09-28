import { useEffect, useRef, useState } from 'react'
import { buildDisplacementMap, ensureGlassFilter } from '../lib/glassRefraction'

export interface UseGlassRefractionResult {
  /** 引擎支援 SVG backdrop-filter 且 glass 開啟(CSS 端 @supports 再降級一次) */
  refractOk: boolean
  /** pill 外殼 ref:滑鼠移動更新 --spec-x/--spec-y 高光 */
  specRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Liquid Glass 真折射(P2-13):位移圖隨視窗尺寸重建,filter 注入 DOM;
 * pill 隨游標 specular。CSS 端 @supports 讓不支援 SVG backdrop-filter 的引擎
 * 自動退回一般 blur。
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
      const map = buildDisplacementMap(w, h, radius, 14, 12)
      ensureGlassFilter('liquid-glass', map, 2)
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

  // pill 隨游標 specular(P2-13):滑鼠移動更新 --spec-x/--spec-y(ref 套在 pill 外殼)
  const specRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = specRef.current
    if (!el) return
    const onMove = (e: MouseEvent): void => {
      const rect = el.getBoundingClientRect()
      el.style.setProperty('--spec-x', `${((e.clientX - rect.left) / rect.width) * 100}%`)
      el.style.setProperty('--spec-y', `${((e.clientY - rect.top) / rect.height) * 100}%`)
      el.style.setProperty('--spec-o', '1')
    }
    const onLeave = (): void => el.style.setProperty('--spec-o', '0')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseout', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseout', onLeave)
    }
  }, [])

  return { refractOk, specRef }
}
