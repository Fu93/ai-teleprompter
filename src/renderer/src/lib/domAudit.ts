import type { DomFinding } from '@shared/types'

/**
 * domAudit.ts — 頁面內 DOM 稽核的**單一實作**。
 *
 * 為什麼要抽成一份:
 *   離線稽核腳本(npm run audit:ui / audit:deep)與 App 內建除錯面板的「稽核」
 *   分頁需要同一套規則。歷史上這份規則有兩份實作(前 scripts/lib/dom-checks.mjs
 *   七條,以及 components/LayoutDebugLayer.tsx 的命中區/裁切子集),而這種複製
 *   一定會漂移 —— 同一個 UI 在除錯面板裡「合格」、在離線稽核裡「不合格」,
 *   然後就沒有人相信任何一份報告了。
 *   上一輪的教訓正是「稽核工具自己有 bug 卻沒人發現」:誤報會讓人開始懷疑整份
 *   報告,然後就不看了。所以新增檢查時,誤報排除邏輯一律寫在各自的註解裡,
 *   寫法上寧可漏報也不要亂叫。
 *
 * 為什麼放在 renderer 而不是 src/shared:
 *   這支只用 DOM API,而 tsconfig.node.json 的 lib 只有 ES2022(主程序不該碰 DOM)。
 *   放進 src/shared 會讓 `npm run typecheck:node` 找不到 Element/getComputedStyle。
 *   稽核腳本以相對路徑直接匯入這個檔案,不經過 @shared 別名。
 *
 * ── 序列化契約(改這個檔案前務必先讀完)──
 *   `domAudit()` 會被 Playwright 的 `page.evaluate(domAudit)` 以
 *   `Function.prototype.toString()` **序列化後送進頁面執行**。這代表:
 *
 *   1. 函式內**不得引用模組層級的任何識別字**(包含下面的 clipperOf /
 *      isSmallTarget / MIN_TAP_PX / MIN_FONT_PX / SMALL_TARGET_SELECTOR)——
 *      那些不會跟著被序列化,頁面裡是 undefined。所以幾何判斷在 `domAudit()`
 *      裡是刻意內聯的,語意與下面匯出的版本一致。**這條沒有例外。**
 *
 *   2. 型別標註**可以**寫:工具鏈的 type stripping(Node 22 的
 *      `--experimental-strip-types`、以及 esbuild/vite)會把標註代換成空白,
 *      所以 toString() 拿到的是語法合法的 JS。但這依賴工具鏈行為,所以兩支
 *      稽核腳本在啟動第一行就呼叫 scripts/lib/audit-report.mjs 的
 *      guardSerializable() 做驗證 —— 換到會保留標註的工具鏈時,會當場爆在
 *      啟動處,而不是某一頁莫名 audit-failed。同一條契約在
 *      src/renderer/src/lib/__tests__/domAudit.test.ts 也有單元測試。
 *
 * 模組層級的 `clipperOf` / `isSmallTarget` / `SMALL_TARGET_SELECTOR` 是給
 * **renderer 端**(除錯面板的版面標記層)用的,不受序列化限制。
 * 兩邊的門檻與排除條件必須一致:命中區門檻是 `MIN_TAP_PX`。
 *
 * 規則清單:
 *   1. low-contrast         文字對比低於 WCAG AA(一般 4.5:1、大字 3:1)
 *   2. small-tap-target     可點擊目標小於 28px
 *   3. thin-slider          range 軌道高度 < 8px(滑鼠難以瞄準)
 *   4. clipped              被「不可捲動的容器」裁掉
 *   5. truncated-no-label   文字被截斷但沒有 title/aria-label
 *   6. no-accessible-name   可操作控制項沒有無障礙名稱
 *   7. text-covered         文字被不透明元素蓋住(取中心點;為何單點就足夠見該節註解;
 *                            `[data-overlay-card]` / `[data-modal-backdrop]` 的覆蓋是刻意宣告的例外)
 *   8. animation-unsettled  有限次動畫在量測時仍在跑(量到的是過渡態)
 *   9. h-overflow-container 意外的橫向捲動容器
 *  10. tiny-text            字級低於可讀下限(對比公式抓不到的那一類)
 */

/** 可點擊目標下限(px)。除錯面板的標記層與離線稽核共用同一個數值。 */
export const MIN_TAP_PX = 28

/** 會被納入命中區檢查的元素。與 domAudit 內部的 selector 必須一致。 */
export const SMALL_TARGET_SELECTOR = 'button, a, [role="button"], input, select, textarea'

/** 字級低於此值即報 tiny-text。對比度只算顏色比值,量不到「字太小」。 */
export const MIN_FONT_PX = 10

/**
 * 找最近一個會真的切掉內容的祖先(overflow 非 visible)。
 *
 * 踩過的坑:原本拿元素跟「視窗」比對,結果 <main> 裡面所有捲動到視窗以下的
 * 內容全部被報成 clipped —— 那不是裁切,那是捲動。使用者不會覺得有問題,
 * 只會覺得這份報告在亂叫。
 *
 * 從元素本身開始往上找(而非父層):元素自己若有 overflow 就該以自己為
 * 裁切容器,否則矩形會跟自己比對而永遠不成立。
 */
export function clipperOf(el: Element): Element {
  let n: Element | null = el
  while (n && n !== document.documentElement) {
    const cs = getComputedStyle(n)
    if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      return n
    }
    n = n.parentElement
  }
  return document.documentElement
}

/**
 * 元素的命中區是否過小。
 *
 * 踩過的坑:原本無差別檢查所有 button/a/input,於是 13x13 的 checkbox 被報出來
 * —— 但它包在 <label> 裡,點文字同樣會切換,實際觸控目標是整個 label,
 * 不是那 13px。range 輸入框的軌道天生就細,拿元素盒高度去比 28px 也不準
 * (Chromium 會另外給命中容差)。所以:在 label 內的輸入框直接略過,
 * range 改看軌道高度是否細到連滑鼠都難以瞄準。
 */
export function isSmallTarget(el: Element): boolean {
  if (!el.matches(SMALL_TARGET_SELECTOR)) return false
  if (el.closest('label')) return false
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  const type = (el.getAttribute('type') || '').toLowerCase()
  const isRange = el.tagName === 'INPUT' && type === 'range'
  return isRange ? r.height < 8 : r.width < MIN_TAP_PX || r.height < MIN_TAP_PX
}

/**
 * 頁面內 DOM 稽核。
 *
 * 這支函式的原始碼會被序列化送進瀏覽器,因此必須完全自足:
 * 不引用模組層級的識別字,也不用 Node API(見檔頭序列化契約)。
 */
export function domAudit(): DomFinding[] {
  const out: DomFinding[] = []
  const srgb = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const lum = (rgb: number[]): number => 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2])
  const parse = (s: string): { rgb: number[]; a: number } | null => {
    const m = s.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1].split(',').map((x) => parseFloat(x))
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }
  }
  // 往上找第一個不透明的背景色,做為該處的實際底色
  const bgOf = (el: Element): number[] => {
    let n: Element | null = el
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0.9) return c.rgb
      n = n.parentElement
    }
    return [10, 12, 17]
  }
  // 往上找第一個會真的切掉內容的祖先(overflow 非 visible)。
  // 這一段與模組層級的 clipperOf 同語意,但必須內聯(見檔頭序列化契約第 1 條)。
  const clipperOfInner = (el: Element): Element => {
    let n: Element | null = el
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        return n
      }
      n = n.parentElement
    }
    return document.documentElement
  }
  /** 元素自己的可見性鏈:任一層透明就等於看不到 */
  const effectivelyVisible = (el: Element): boolean => {
    let n: Element | null = el
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
      if (parseFloat(cs.opacity) === 0) return false
      n = n.parentElement
    }
    return true
  }

  const seen = new Set<string>()
  const all = Array.from(document.querySelectorAll('*'))
  // 只收集「本身有文字」的元素,後面重疊檢查要用
  const textEls: Array<{ el: Element; r: DOMRect }> = []

  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue

    // 1. 文字對比(WCAG AA 一般文字 4.5:1)
    const hasText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 1
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

      // 10. 字級下限。對比公式只看顏色比值,9px 的淺色字會通過對比檢查但沒人讀得到。
      //     只看「本身有文字」的元素,繼承字級的大容器不必重複報。
      if (parseFloat(cs.fontSize) < 10) {
        const key = 'tinytext:' + el.className + ':' + cs.fontSize
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'tiny-text',
            text: `${cs.fontSize} (下限 10px) class="${String(el.className).slice(0, 60)}"`
          })
        }
      }
    }

    // 2. 可點擊目標過小(<28px)。
    //    與模組層級的 isSmallTarget 同語意,這裡刻意內聯(見檔頭序列化契約第 1 條)。
    //    排除:label 內的輸入框(點文字同樣有效)、range 改看軌道高度。
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
    const clip = clipperOfInner(el)
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
    //    排除自己就是橫向捲動容器的情況:那裡的 scrollWidth > clientWidth
    //    是「捲得到」而不是「被截斷」,報出來就是把設計當缺陷(工具列外殼就是)。
    const selfScrollsX = cs.overflowX === 'auto' || cs.overflowX === 'scroll'
    if (hasText && !selfScrollsX && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      if (!el.getAttribute('title') && !el.getAttribute('aria-label')) {
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
      const labelledBy = el.getAttribute('aria-labelledby')
      const name =
        (el.textContent || '').trim() ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        (labelledBy ? (document.getElementById(labelledBy)?.textContent || '').trim() : '') ||
        (el.tagName === 'INPUT' ? String((el as HTMLInputElement).value || '').trim() : '')
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
  //  - 覆蓋者若自己宣告了 data-overlay-card(故意蓋住內容的暫態卡片,例如浮層的
  //    Panic 救援卡)或 data-modal-backdrop(模態對話框的滿版遮罩),則不算缺陷。
  //    與 data-allow-h-scroll 同一套思路:工具分不出
  //   意圖,由元素自己宣告。貼鏡視窗只有 170px 高,救援卡不可能不蓋到正文 ——
  //   一個設計上必然的覆蓋若永遠留在報告裡,只會訓練人忽略報告。
  //
  // ── 為什麼只量中心點就夠了(這一條被「改善」過一次,結果是白做的)──
  // 原本想過改成中心 + 四個 1/4 點,理由是「文字被蓋住一半、只在邊緣露出一截
  // 時中心點還在,抓不到」。那個理由**是錯的**,證明如下:
  //
  //   筛選條件要求覆蓋者與被蓋元素的「相交矩形」面積 ≥ 被蓋元素的 60%。
  //   相交矩形必然是被蓋元素的子矩形。若它不包含中心點,則它在 x 或 y
  //   軸上位於中心點一側,也就是該軸上的長度不超過一半 —— 面積因此 ≤ 50%,
  //   與 ≥ 60% 矛盾。所以「面積 ≥ 60%」本身就已經等價於「包含中心點」。
  //
  // 多點取樣不增加任何偵測能力,卻把每個有文字的元素從 1 次 hit test
  // 變成 5 次(除錯面板是互動式在跑這支函式,差別感受得到)。所以維持單點。
  const area = (a: DOMRect, b: DOMRect): number => {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
    return w * h
  }
  /** 鏈上所有背景的累積不透明度 */
  const opaqueBackdrop = (el: Element): number => {
    let a = 1
    let n: Element | null = el
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
    // 中心點不在視窗內就沒必要量(看得到的文字本來就只會被視窗內的東西遮到)
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue
    const saved = (el as HTMLElement).style.pointerEvents
    ;(el as HTMLElement).style.pointerEvents = 'auto'
    const stack = document.elementsFromPoint(cx, cy)
    ;(el as HTMLElement).style.pointerEvents = saved
    const idx = stack.indexOf(el)
    if (idx <= 0) continue
    // stack[0] 是最上層;只看真的畫在 el 上方的那幾層
    const hit = stack.slice(0, idx).find((a) => {
      if (a === el || a.contains(el)) return false
      if (!effectivelyVisible(a)) return false
      // 故意蓋住內容的暫態卡片、以及模態對話框的滿版遮罩,自己宣告豁免。
      // 兩者的理由相同:覆蓋是設計要的 —— 救援卡在 170px 的貼鏡視窗裡不可能不蓋到正文,
      // 而「對話框蓋住背景」正是模態的定義。工具分不出意圖,由元素宣告。
      if (a.closest && a.closest('[data-overlay-card]')) return false
      if (a.closest && a.closest('[data-modal-backdrop]')) return false
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
  const stuck: string[] = []
  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (!el.getAnimations) continue
    const running = el.getAnimations().filter((a) => {
      const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null
      const it = timing ? timing.iterations : 1
      return a.playState === 'running' && it !== Infinity
    })
    if (running.length) {
      stuck.push(
        `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 40)}"> ${running.length} 個動畫仍在跑(${running
          .map((a) => {
            const name = (a as unknown as { animationName?: string }).animationName || a.constructor.name
            const it = a.effect ? a.effect.getComputedTiming().iterations : '?'
            return name + ':' + (it ?? '?')
          })
          .join(', ')})`
      )
    }
  }
  for (const s of stuck.slice(0, 8)) {
    out.push({ kind: 'animation-unsettled', text: s })
  }

  return out
}
