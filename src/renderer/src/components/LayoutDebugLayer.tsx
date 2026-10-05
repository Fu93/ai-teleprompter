/**
 * LayoutDebugLayer.tsx — 主視窗與浮層共用的版面除錯層。
 *
 * 為什麼共用一份:
 *   浮層的版面 bug(工具列溢出被裁掉、藥丸按鈕落在視窗外、貼鏡模式按鈕壓到正文)
 *   全部都是「元素相對最近的裁切容器」與「命中區過小」這兩種型態,
 *   而這兩種量測需要同一套幾何規則。抄兩份一定會漂移 —— 這個專案已經在
 *   稽核工具上記過一次同樣的教訓:那次的後果是深狀態從未被量測,
 *   而報告仍是一份漂亮的空清單。
 *
 * 因此幾何規則不再寫在這裡:MIN_TAP_PX / isSmallTarget / clipperOf 都從
 * ../lib/domAudit 匯入,與離線稽核(scripts/audit-*.mjs)及除錯面板的
 * 「稽核」分頁完全同一份。同一個 UI 不該在除錯面板裡「合格」、
 * 在離線稽核裡「不合格」。
 *
 * 為什麼標記要用 JS 掃描而不是純 CSS:
 *   「比最近的裁切祖先還寬」與「高度低於 28px」都是幾何比較,純 CSS 做不到。
 *   CSS 只負責把結果畫出來(外框),判斷留在這裡。
 */
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { useDebug } from '../lib/debug'
import { useEscape } from '../lib/useEscape'
import {
  SMALL_TARGET_SELECTOR,
  clipperOf,
  isSmallTarget,
  isSmallLabelTarget,
  isThinTrack
} from '../lib/domAudit'

/**
 * 標記掃描的元素數上限。列出數千列時(會議逐字稿)逐元素量測會拖慢畫面,
 * 而除錯工具把 App 拖慢本身就是一種汙染 —— 寧可少標,也不要改變被觀察的行為。
 */
const MAX_SCAN_ELEMENTS = 3000

function clearTags(): void {
  for (const el of document.querySelectorAll('[data-dbg-small],[data-dbg-clipped]')) {
    el.removeAttribute('data-dbg-small')
    el.removeAttribute('data-dbg-clipped')
  }
}

/**
 * 命中區過小的控制項。規則(isSmallTarget / isSmallLabelTarget / isThinTrack)
 * 與離線稽核完全同一份。
 *
 * 為什麼要掃三個集合:SMALL_TARGET_SELECTOR 不含 label,而 isSmallLabelTarget
 * 量的是 label、isThinTrack 量的是 range 的軌道。少標一個集合等於除錯面板與
 * 離線稽核對「同一個問題」給出不同答案 —— 那正是本檔檔頭說要避免的漂移。
 * 三者都標同一個屬性(data-dbg-small),因為對使用者而言它們是同一件事:
 * 這個控制項不好用。
 */
function tagSmallTargets(): void {
  for (const el of document.querySelectorAll(SMALL_TARGET_SELECTOR)) {
    if (isSmallTarget(el) || isThinTrack(el)) el.setAttribute('data-dbg-small', '1')
  }
  for (const el of document.querySelectorAll('label')) {
    if (isSmallLabelTarget(el)) el.setAttribute('data-dbg-small', '1')
  }
}

/**
 * 被非捲動容器裁掉的元素。與 domAudit 的關鍵差異:
 * 容器在該軸可捲動時「超出」是設計而非裁切(浮層工具列就是橫向可捲動的),
 * 因此只在不可捲動的那個軸上標記。
 */
function tagClipped(): void {
  const all = document.querySelectorAll<HTMLElement>('*')
  if (all.length > MAX_SCAN_ELEMENTS) return
  for (const el of all) {
    if (el === document.body || el === document.documentElement) continue
    if (el.hasAttribute('data-dbg-small')) continue // 已標成命中區問題,避免兩種框打架
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const clip = clipperOf(el)
    const ccs = getComputedStyle(clip)
    const cr = clip.getBoundingClientRect()
    const overX = r.right > cr.right + 1 || r.left < cr.left - 1
    const overY = r.bottom > cr.bottom + 1 || r.top < cr.top - 1
    if (!overX && !overY) continue
    const scrollsX = ccs.overflowX === 'auto' || ccs.overflowX === 'scroll'
    const scrollsY = ccs.overflowY === 'auto' || ccs.overflowY === 'scroll'
    if ((overX && !scrollsX) || (overY && !scrollsY)) el.setAttribute('data-dbg-clipped', '1')
  }
}

/** 游標檢視器:顯示游標下元素的 tag/class/尺寸/文字色,點擊即複製 */
function Picker(): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const labelRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef('')

  // Esc 關閉檢視器。少了這個,開啟後就必須用滑鼠把開關點回來,
  // 而檢視器會攔下所有 mousedown —— 連「關掉它」那一點都很容易點錯。
  useEscape(() => useDebug.getState().toggleLayout('pick'))

  useEffect(() => {
    const describe = (el: HTMLElement): string => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
      return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}> ${Math.round(r.width)}×${Math.round(r.height)} ${cs.color} / ${cs.fontSize}`
    }
    const onMove = (e: MouseEvent): void => {
      const box = boxRef.current
      const label = labelRef.current
      if (!box || !label) return
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      if (!el) return
      const r = el.getBoundingClientRect()
      box.style.transform = `translate(${r.left}px, ${r.top}px)`
      box.style.width = `${r.width}px`
      box.style.height = `${r.height}px`
      textRef.current = describe(el)
      label.textContent = textRef.current
      label.style.transform = `translate(${Math.max(
        4,
        Math.min(e.clientX + 12, window.innerWidth - label.offsetWidth - 8)
      )}px, ${Math.max(4, e.clientY + 18)}px)`
    }
    // capture:浮層內多數元素會吃掉 mousemove(drag region、no-drag 子樹),
    // 檢視器必須在捕獲階段先看到才不會漏。
    const onDown = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const text = textRef.current
      if (text) {
        void navigator.clipboard?.writeText(text)
        void window.api?.logFromRenderer?.('INFO', `[debug-picker] ${text}`)
      }
    }
    window.addEventListener('mousemove', onMove, { capture: true, passive: true })
    window.addEventListener('mousedown', onDown, { capture: true })
    return () => {
      window.removeEventListener('mousemove', onMove, { capture: true })
      window.removeEventListener('mousedown', onDown, { capture: true })
    }
  }, [])

  return (
    <>
      <div ref={boxRef} className="dbg-picker-box" />
      <div ref={labelRef} className="dbg-picker-label" />
    </>
  )
}

const CSS = `
/* 外框只改 outline,不動 background-color / box-shadow / 尺寸:
   除錯層若改變了被觀察元素的繪製,量到的就不是原本的畫面。 */
html.dbg-outline * {
  outline: 1px solid rgba(143, 140, 250, 0.5) !important;
  outline-offset: -1px;
}
html.dbg-outline [data-dbg-small] { outline: 2px solid #f56a8a !important; outline-offset: 0 !important; }
html.dbg-outline [data-dbg-clipped] { outline: 2px dashed #f5b04d !important; outline-offset: 0 !important; }
html.dbg-hits [data-dbg-small] { outline: 2px solid #f56a8a !important; outline-offset: 0 !important; }
html.dbg-overflow [data-dbg-clipped] { outline: 2px dashed #f5b04d !important; outline-offset: 0 !important; }
.dbg-picker-box {
  position: fixed; left: 0; top: 0; z-index: 2147483646;
  pointer-events: none; border: 1px solid #8f8cfa; background: rgba(143, 140, 250, 0.14);
}
.dbg-picker-label {
  position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
  font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #e9ecf5; background: rgba(10, 12, 17, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 4px;
  padding: 2px 6px; white-space: nowrap; max-width: 92vw; overflow: hidden; text-overflow: ellipsis;
}
`

/**
 * 掛在兩個視窗的根層。未啟用或沒開任何開關時只回傳 null(不進 DOM、不監聽)。
 */
export function LayoutDebugLayer(): JSX.Element | null {
  const enabled = useDebug((s) => s.enabled)
  const layout = useDebug((s) => s.layout)
  const { outline, hits, overflow, pick } = layout

  // 開關以 class 掛在 <html>:CSS 能一次涵蓋整個視窗(含 fixed 定位的圖層)
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dbg-outline', enabled && outline)
    root.classList.toggle('dbg-hits', enabled && hits)
    root.classList.toggle('dbg-overflow', enabled && overflow)
    return () => root.classList.remove('dbg-outline', 'dbg-hits', 'dbg-overflow')
  }, [enabled, outline, hits, overflow])

  // 幾何標記:版面會隨互動改變,用 rAF 節流 + MutationObserver 重掃
  useEffect(() => {
    if (!enabled || (!hits && !overflow)) {
      clearTags()
      return
    }
    let raf = 0
    const run = (): void => {
      clearTags()
      if (hits) tagSmallTargets()
      if (overflow) tagClipped()
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(run)
    }
    run()
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      window.removeEventListener('resize', schedule)
      clearTags()
    }
  }, [enabled, hits, overflow])

  if (!enabled) return null

  return (
    <>
      <style>{CSS}</style>
      {pick && <Picker />}
    </>
  )
}
