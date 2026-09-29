/**
 * dom-checks.mjs — 頁面內 DOM 稽核的單一實作。
 *
 * 為什麼要抽出來:audit-ui.mjs(六頁 × 預設狀態)與 audit-deep.mjs
 * (播種資料 × 深度狀態 × 多視窗 × 浮層)需要同一套規則。複製兩份一定會漂移,
 * 而上一輪的教訓正是「稽核工具自己有 bug 卻沒人發現」——
 * 誤報會讓人開始懷疑整份報告,然後就不看了。
 *
 * 這個函式會被 page.evaluate() 序列化後送進瀏覽器執行,因此必須是
 * 完全自足的純函式:不能引用外部變數,也不能用 Node API。
 *
 * 新增檢查的誤報排除邏輯都寫在各自的註解裡。寫法上寧可漏報也不要亂叫。
 */

/**
 * @returns {{kind: string, text: string}[]}
 */
export function domAudit() {
  const out = []
  const srgb = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
  const parse = (s) => {
    const m = s.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1].split(',').map((x) => parseFloat(x))
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }
  }
  // 往上找第一個不透明的背景色,做為該處的實際底色
  const bgOf = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0.9) return c.rgb
      n = n.parentElement
    }
    return [10, 12, 17]
  }
  // 往上找第一個會真的切掉內容的祖先(overflow 非 visible)。
  // 踩過的坑:原本拿元素跟「視窗」比對,結果 <main> 裡面所有捲動到
  // 視窗以下的內容全部被報成 clipped —— 那不是裁切,那是捲動。
  // 使用者不會覺得有問題,只會覺得這份報告在亂叫。
  const clipperOf = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        return n
      }
      n = n.parentElement
    }
    return document.documentElement
  }
  /** 元素自己的可見性鏈:任一层透明就等於看不到 */
  const effectivelyVisible = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
      if (parseFloat(cs.opacity) === 0) return false
      n = n.parentElement
    }
    return true
  }

  const seen = new Set()
  const all = Array.from(document.querySelectorAll('*'))
  // 只收集「本身有文字」的元素,後面重疊檢查要用
  const textEls = []

  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue

    // 1. 文字對比(WCAG AA 一般文字 4.5:1)
    const hasText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 1
    )
    if (hasText) {
      textEls.push({ el, r })
      const fg = parse(cs.color)
      if (fg && fg.a > 0.5) {
        const L1 = lum(fg.rgb)
        const L2 = lum(bgOf(el))
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
        const size = parseFloat(cs.fontSize)
        const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700)
        const need = large ? 3 : 4.5
        if (ratio < need) {
          const key = 'contrast:' + el.className + ':' + size
          if (!seen.has(key)) {
            seen.add(key)
            out.push({
              kind: 'low-contrast',
              text: `${ratio.toFixed(2)}:1 (需 ${need}) size=${size}px color=${cs.color} class="${String(el.className).slice(0, 60)}"`
            })
          }
        }
      }
    }

    // 2. 可點擊目標過小(<28px)。
    //    踩過的坑:原本無差別檢查所有 button/a/input,於是 13x13 的
    //    checkbox 被報出來 —— 但它包在 <label> 裡,點文字同樣會切換,
    //    實際觸控目標是整個 label,不是那 13px。range 輸入框的軌道
    //    天生就細,拿元素盒高度去比 28px 也不準(Chromium 會另外給
    //    命中容差)。所以:在 label 內的輸入框直接略過,range 改看
    //    軌道高度是否細到連滑鼠都難以瞄準。
    const type = (el.getAttribute('type') || '').toLowerCase()
    const isRange = el.tagName === 'INPUT' && type === 'range'
    const inLabel = !!el.closest('label')
    const clickable =
      el.matches('button, a, [role="button"]') ||
      (el.matches('input, select, textarea') && !inLabel)
    if (clickable && !inLabel) {
      const tooSmall = isRange ? r.height < 8 : r.width < 28 || r.height < 28
      if (tooSmall) {
        const key = 'tap:' + el.tagName + ':' + type + ':' + Math.round(r.width) + 'x' + Math.round(r.height)
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: isRange ? 'thin-slider' : 'small-tap-target',
            text: `<${el.tagName.toLowerCase()}${type ? ' type=' + type : ''}> ${Math.round(r.width)}x${Math.round(r.height)} class="${String(el.className).slice(0, 50)}"`
          })
        }
      }
    }

    // 3. 元素被「會切掉它的容器」裁掉。
    //    重點:容器如果在那個軸上可捲動,超出部分就還在捲動範圍內,
    //    使用者捲得到就不算被裁掉。浮層工具列就是橫向可捲動的,
    //    裡面按鈕「超出」容器是設計而不是裁切。
    const clip = clipperOf(el)
    const ccs = getComputedStyle(clip)
    const cr = clip.getBoundingClientRect()
    const overX = r.right > cr.right + 1 || r.left < cr.left - 1
    const overY = r.bottom > cr.bottom + 1 || r.top < cr.top - 1
    if (overX || overY) {
      const scrollsX = ccs.overflowX === 'auto' || ccs.overflowX === 'scroll'
      const scrollsY = ccs.overflowY === 'auto' || ccs.overflowY === 'scroll'
      // 超出發生在可捲動的那個軸上就算數
      if ((overX && !scrollsX) || (overY && !scrollsY)) {
        const key = 'clip:' + el.tagName + ':' + clip.tagName
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'clipped',
            text: `<${el.tagName.toLowerCase()}> 超出 <${clip.tagName.toLowerCase()}> 邊界 rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} clip=${Math.round(cr.left)},${Math.round(cr.top)} ${Math.round(cr.width)}x${Math.round(cr.height)} class="${String(el.className).slice(0, 50)}"`
          })
        }
      }
    }

    // 4. 文字被截斷但沒有 title/aria-label(使用者看不到完整內容)
    if (hasText && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      if (!el.title && !el.getAttribute('aria-label')) {
        const key = 'trunc:' + el.className
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'truncated-no-label',
            text: `scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth} class="${String(el.className).slice(0, 50)}"`
          })
        }
      }
    }

    // 5. 可操作控制項沒有無障礙名稱。螢幕閱讀器只會報「按鈕」,
    //    使用者不知道要按什麼。icon-only 按鈕最容易中招。
    //    (toggle 缺 role/aria-checked 這類要另外查,通用規則抓不到。)
    if (el.matches('button, a, input, select, textarea') && !inLabel) {
      const type2 = (el.getAttribute('type') || '').toLowerCase()
      // hidden 沒有可存取名稱是正常的;submit/button/reset 預設用 value
      const implicit = ['hidden', 'submit', 'button', 'reset', 'image'].includes(type2)
      const name =
        (el.textContent || '').trim() ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        (el.getAttribute('aria-labelledby')
          ? (document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || '').trim()
          : '') ||
        (el.tagName === 'INPUT' && el.value ? String(el.value).trim() : '')
      if (!name && !implicit && !inLabel) {
        const key = 'anon:' + el.tagName + ':' + String(el.className).slice(0, 40)
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'no-accessible-name',
            text: `<${el.tagName.toLowerCase()}${type2 ? ' type=' + type2 : ''}> class="${String(el.className).slice(0, 60)}"`
          })
        }
      }
    }

    // 8. 橫向捲動容器。桌面 App 裡意外的橫向捲動幾乎都是版面 bug,
    //    但「刻意讓工具列橫向捲動」是合理設計。工具無法分辨意圖,
    //    所以提供 data-allow-h-scroll 明確宣告例外,而不是在這裡猜。
    const ox = cs.overflowX
    if (
      (ox === 'auto' || ox === 'scroll') &&
      el.scrollWidth > el.clientWidth + 2 &&
      el.clientWidth > 0 &&
      !el.hasAttribute('data-allow-h-scroll')
    ) {
      const key = 'hoverflow:' + el.className
      if (!seen.has(key)) {
        seen.add(key)
        out.push({
          kind: 'h-overflow-container',
          text: `<${el.tagName.toLowerCase()}> scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth}(多 ${el.scrollWidth - el.clientWidth}px) class="${String(el.className).slice(0, 60)}"`
        })
      }
    }
  }

  // ── 6. 文字被不透明元素蓋住 ──
  // 踩到的坑(實測確認,不是推測):elementsFromPoint 跟 elementFromPoint
  // 一樣是「hit test」,會把 pointer-events:none 的元素整個排除在堆疊之外。
  // 浮層貼鏡模式的提示正是 pointer-events-none 的非互動標籤,所以它根本不會
  // 出現在堆疊裡。中間那版用 n.contains(el) 去配對,配到的是它的「祖先」
  // (glass-overlay),再把祖先上方的靜態兄弟誤當成蓋住它的東西 ——
  // 報出一個根本不存在的問題,而且還以為是 z-order 的 bug。
  //
  // 正確做法:量測期間暫時把它的 pointer-events 打開,讓它出現在真實的繪製
  // 堆疊裡,量完立刻還原。這樣索引就是它真正的繪製位置。
  //
  // 其餘誤報排除:
  //  - 覆蓋者必須本身不透明(自身+祖先的背景 alpha > 0.85)。半透明裝飾層
  //    (玻璃面板的 rgba 背景、toast 的 backdrop-blur)不會擋住閱讀。
  //  - 覆蓋者面積必須大於被蓋元素的 60%。icon 疊在文字邊角、chevron 壓在
  //    邊框上這類都會被這條篩掉。
  //  - 覆蓋者要看得見,否則 display:none 的層會把底下所有東西都「蓋住」。
  const area = (a, b) => {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    return w * h
  }
  /** 鏈上所有背景的累積不透明度 */
  const opaqueBackdrop = (el) => {
    let a = 1
    let n = el
    while (n && n !== document.documentElement && a < 0.85) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c) a *= c.a
      n = n.parentElement
    }
    return a
  }
  for (const { el, r } of textEls) {
    if (!effectivelyVisible(el)) continue
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue
    const saved = el.style.pointerEvents
    el.style.pointerEvents = 'auto'
    const stack = document.elementsFromPoint(cx, cy)
    el.style.pointerEvents = saved
    const idx = stack.indexOf(el)
    if (idx <= 0) continue
    // stack[0] 是最上層;只看真的畫在 el 上方的那幾層
    const hit = stack.slice(0, idx).find((a) => {
      if (a === el || a.contains(el)) return false
      if (!effectivelyVisible(a)) return false
      if (opaqueBackdrop(a) < 0.85) return false
      return area(r, a.getBoundingClientRect()) >= r.width * r.height * 0.6
    })
    if (!hit) continue
    const key = 'covered:' + el.className
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      kind: 'text-covered',
      text: `<${el.tagName.toLowerCase()}>「${(el.textContent || '').trim().slice(0, 20)}」被 <${hit.tagName.toLowerCase()} class="${String(hit.className).slice(0, 40)}"> 蓋住`
    })
  }

  // ── 7. 動畫沒有收斂 ──
  // 只看「有限次」且仍在 running 的動畫。iterations === Infinity 的
  // (呼吸光暈、載入 spinner)是我們要的常駐動畫,不算沒收斂。
  // 這個檢查的價值:先前白邊診斷最大的教訓就是「在動畫中途量測」,
  // 量到的是過渡狀態而不是使用者看到的樣子。
  const stuck = []
  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (!el.getAnimations) continue
    const running = el.getAnimations().filter((a) => {
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null
      const it = t ? t.iterations : 1
      return a.playState === 'running' && it !== Infinity
    })
    if (running.length) {
      stuck.push(
        `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 40)}"> ${running.length} 個動畫仍在跑(${running
          .map((a) => (a.animationName || a.constructor.name) + ':' + (a.effect.getComputedTiming().iterations ?? '?'))
          .join(', ')})`
      )
    }
  }
  for (const s of stuck.slice(0, 8)) {
    out.push({ kind: 'animation-unsettled', text: s })
  }

  return out
}
