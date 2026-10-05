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
 *   3. small-label-target   包住表單控制項的 <label> 小於 28px(輸入框本身被
 *                            規則 2 刻意略過,而它才是真實命中區 —— 見 isSmallLabelTarget)
 *   4. thin-slider          range 軌道高度細到連滑鼠都難以瞄準(< 3px;
 *                            門檻從 8px 降下來的理由見該規則的註解)
 *   5. clipped              被「不可捲動的容器」裁掉
 *   6. truncated-no-label   文字被截斷但沒有 title/aria-label
 *   7. no-accessible-name   可操作控制項沒有無障礙名稱
 *   8. text-covered         文字被不透明元素蓋住(取中心點;為何單點就足夠見該節註解;
 *                            `[data-overlay-card]` / `[data-modal-backdrop]` 的覆蓋是刻意宣告的例外)
 *   9. animation-unsettled  有限次動畫在量測時仍在跑(量到的是過渡態)
 *  10. h-overflow-container 意外的橫向捲動容器
 *  11. tiny-text            字級低於可讀下限(對比公式抓不到的那一類)
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
 * 不是那 13px。所以:在 label 內的輸入框直接略過(那個歸屬由 isSmallLabelTarget
 * 接手 —— 輸入框的命中區既然被算給了 label,label 本身就必須夠大)。
 *
 * range **在這裡一律回 false**,軌道由 isThinTrack 單獨量。原因見該函式。
 */
export function isSmallTarget(el: Element): boolean {
  if (!el.matches(SMALL_TARGET_SELECTOR)) return false
  if (el.closest('label')) return false
  const type = (el.getAttribute('type') || '').toLowerCase()
  // range 的元素高度是**命中帶**(第四輪 P2-2 從 22px 改成 28px),拿它去比
  // 28px 永遠成立;而它宣稱要量的**軌道**是偽元素,這個函式量不到。
  if (el.tagName === 'INPUT' && type === 'range') return false
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  return r.width < MIN_TAP_PX || r.height < MIN_TAP_PX
}

/**
 * range 的軌道細到瞄不準(< 3px)。與 domAudit 的 thin-slider 同語意。
 *
 * 門檻 3px 的來由(**先量過才定**):這個專案的滑桿軌道真實高度是 **4px**
 * (global.css 的 ::-webkit-slider-runnable-track),而那是被 P2-2 刻意保留的
 * 視覺 —— 元素撐到 28px 當命中帶、軌道維持 4px 畫線,兩者分工不同。門檻必須
 * 低於「已知良好」的 4px,否則六個滑桿會全部被報,而把正確的設計回報成缺陷
 * 正是這個專案拒絕做的事。2px 在深色背景上就幾乎看不見,那才是真的值得報。
 *
 * 量不到軌道時回 false(非 WebKit、或沒有自訂 track):寧可漏報也不誤報。
 */
export function isThinTrack(el: Element): boolean {
  if (el.tagName !== 'INPUT') return false
  if ((el.getAttribute('type') || '').toLowerCase() !== 'range') return false
  if (el.getBoundingClientRect().width <= 0) return false
  const h = trackHeightFromCssom(el)
  return h !== null && h > 0 && h < 3
}

/**
 * 從 **CSSOM** 讀出 range 軌道的宣告高度(px);讀不到回 null。
 *
 * ## 為什麼不能用 getComputedStyle(這裡踩過,值得寫下來)
 *
 * 直覺上應該是 `getComputedStyle(el, '::-webkit-slider-runnable-track').height`。
 * 實測(2026-10-05,真實 Chromium / Electron 44)證明**那行永遠回傳元素的
 * 高度**,不管軌道被設成 2px、4px 還是 6px —— 三次都拿到 28px:
 *
 *     軌道 2px → getComputedStyle(偽元素).height = "28px"   ← 元素的高度
 *     軌道 4px → "28px"
 *     軌道 6px → "28px"
 *
 * 帶引號的寫法(`"'::-…'"`)與 `getPropertyValue('height')` 也一樣是 28px。
 * 也就是說偽元素查詢在這個引擎上**靜默退化成查元素本身**,不報錯、不警告 ——
 * 所以第一版的修正是「把一條不會觸發的規則換成另一條不會觸發的規則」。
 *
 * 可行的做法是走 CSSOM:`document.styleSheets` → `cssRules` → 找 selectorText
 * 含 `slider-runnable-track` 且對應到這個元素的規則,讀它的 `style.height`。
 * 同一組測試下 CSSOM 正確回傳 2 / 4 / 6。
 *
 * ## 邊界(每條都有理由)
 *
 *   - **只讀同一個 document 的 stylesheets**:外部樣式表(Cross-origin)的
 *     `cssRules` 會拋 SecurityError,一律 catch 掉當作讀不到 → 不報。
 *   - **只認完全匹配的元素自己的規則**:`#id::-…`、`input[name=x]::-…`、
 *     `.cls::-…`。萬用選擇器(無前置條件)不算,因為無法確定它作用在哪個元素上。
 *   - **讀不到就回 null → 不報**:寧可漏報也不誤報。這與「軌道高度拿不到」
 *     的真實情況(沒有自訂 track、用瀏覽器預設外觀)一致。
 *   - **不解析 `height: auto`**:非 px 值一律當成讀不到。
 */
function trackHeightFromCssom(el: Element): number | null {
  if (el.tagName !== 'INPUT') return null
  if ((el as HTMLInputElement).type !== 'range') return null

  let sheets: StyleSheetList
  try {
    sheets = document.styleSheets
  } catch {
    return null
  }

  let bestPx: number | null = null
  let bestSpec = -1
  for (let i = 0; i < sheets.length; i++) {
    let rules: CSSRuleList
    try {
      rules = sheets[i].cssRules
    } catch {
      continue // cross-origin
    }
    for (let j = 0; j < rules.length; j++) {
      const rule = rules[j] as CSSStyleRule
      const sel = rule.selectorText
      if (!sel || !rule.style) continue
      for (const part of sel.split(',')) {
        const s = part.trim()
        if (!s.endsWith('::-webkit-slider-runnable-track')) continue
        const base = s.slice(0, -'::-webkit-slider-runnable-track'.length).trim()
        // base 必須真的綁到這個元素,且不是萬用選擇器
        if (base === '' || base === '*') continue
        let hit = false
        try {
          hit = el.matches(base)
        } catch {
          hit = false
        }
        if (!hit) continue
        const px = parseFloat(rule.style.height)
        if (!Number.isFinite(px) || px <= 0) continue
        // 具體度:id > class > 屬性 > 元素(與 CSS 規則一致的近似)
        const spec = base.startsWith('#') ? 100 : base.startsWith('.') ? 10 : base.includes('[') ? 5 : 1
        if (spec > bestSpec) {
          bestSpec = spec
          bestPx = px
        }
      }
    }
  }
  return bestPx
}

/**
 * 包住 form control 的 <label> 本身是不是過小的命中區。
 *
 * ## 為什麼需要這一條(isSmallTarget 抓不到這件事)
 *
 * isSmallTarget 對「在 label 內的輸入框」一律略過 —— 理由寫在它的註解裡:
 * 13x13 的 checkbox 包在 label 裡時,使用者的觸控目標是**整個 label**,不是那 13px。
 * 那個判斷是對的。但它有一個後果:**label 自己變小時,沒有任何人報。**
 *
 * 實測過的案例(第四輪 P2-1):錄音頁兩個音訊來源的 label 是 113x20 / 155x20,
 * 20px 低於本專案自己在 ToastHost 用的 28px。而當時**所有稽核都綠** —— 因為
 * 被量到的是 13px 的 input,而那條規則刻意略過 label 內的輸入框。規則的「不誤報」
 * 保證是對的,代價是這類缺陷有了一個結構性的盲區。
 *
 * 所以這一條量的是**那個被當成真實命中區的東西本身**。輸入框的命中區既然被
 * 歸給了 label,那麼 label 就必須自己夠大 —— 否則那個歸屬只是一句空話。
 *
 * ## 邊界
 *
 *   - 只看**直接包住**控制項的 label(`label.matches('input, select, textarea')`
 *     或 control.closest('label') === label)。巢狀 label 不合法,不需處理。
 *   - 沒有可見文字的 label 排除:那類多半是 layout 包裝而非可點擊區域,
 *     把它算進來會讓規則變成一個發報機。至少要有文字或 title 才算。
 *   - width 不設門檻:label 是橫向的(113/155px),寬度不是問題。
 *   - **不**取代 isSmallTarget 的 label 略過 —— 那一半仍要略過,否則同一個
 *     控制項會被報兩次(一次 13px 的 input、一次 20px 的 label)。
 */
export function isSmallLabelTarget(el: Element): boolean {
  if (el.tagName !== 'LABEL') return false
  // 必須真的包住一個可切換的控制項,否則它只是版面
  const owns = el.querySelector('input, select, textarea')
  if (!owns) return false
  // 「可點擊」的證據:有可見文字或有 title,而不是純空間
  const text = (el.textContent ?? '').trim()
  const labelled = text.length > 0 || !!el.getAttribute('title')
  if (!labelled) return false
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  return r.height < MIN_TAP_PX
}

/**
 * settleAnimations — 量測之前先等「有限次、正在跑」的動畫跑完。
 *
 * 這是**量測端**的修正,不是產品的。背景:domAudit 的第 8 條規則
 * animation-unsettled 會回報「取樣當下還在跑的有限次動畫」,它存在的理由是
 * 白邊診斷的教訓 —— 在過渡態量測,量到的不是使用者看到的樣子。但取樣點常常
 * 正好壓在某個 transition 的尾巴上:探針 hover 一顆按鈕 → transition-colors
 * 開始 → 立刻取樣 → 報七筆。實測 2026-10-04:同一份 build、同一行程式碼,
 * audit:deep 三跑一紅,而產品一行都沒改。
 *
 * 正確的修法不是放寬規則(放寬 =「在動畫中途量測」這個提醒會跟著消失),
 * 而是**讓量測發生在動畫結束之後**:該報的「動畫永遠收斂不了」照報,
 * 「只是還在跑」不再誤報。規則語意沒變,變的是取樣時機。
 *
 * 邊界(每一條都有理由,不是防禦性程式碼):
 *   - iterations === Infinity(呼吸光暈、spinner)本來就被規則排除,這裡也不等。
 *   - 收斂不了的動畫不能讓整份稽核永久卡住:每個動畫最多等 waitCapMs。
 *   - settle 本身可能又觸發新的 transition,所以最多跑 settlePasses 輪。
 *     常見情況第一輪就是 0 個在跑,立刻返回 —— 不會讓稽核變慢。
 *
 * 序列化契約與 domAudit() 相同:函式內不得引用模組層級識別字。
 */
export async function settleAnimations(waitCapMs = 600, settlePasses = 3): Promise<void> {
  for (let pass = 0; pass < settlePasses; pass++) {
    const running =
      typeof document !== "undefined" && document.getAnimations ? document.getAnimations() : []
    const pending = running.filter((a) => {
      const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null
      const it = timing ? timing.iterations : 1
      return a.playState === "running" && it !== Infinity
    })
    if (pending.length === 0) return
    await Promise.all(
      pending.map((a) =>
        Promise.race([
          a.finished.catch(() => undefined),
          new Promise((r) => setTimeout(r, waitCapMs))
        ])
      )
    )
  }
}

/**
 * 頁面內 DOM 稽核。
 *
 * 這支函式的原始碼會被序列化送進瀏覽器,因此必須完全自足:
 * 不引用模組層級的識別字,也不用 Node API(見檔頭序列化契約)。
 */
export function domAudit(): DomFinding[] {
  const out: DomFinding[] = []
  /**
   * 每條規則的**評估次數**(不是命中次數)。
   *
   * 為什麼要這個:`thin-slider` 存在三輪、看起來在工作,卻一次都沒觸發過 ——
   * 而「0 筆問題」正是它在報告裡的樣子。沒有計數,「從不觸發的規則」與
   * 「很有用的規則」在報告裡無法區分。
   *
   * 計數是「有機會被評估」的次數,不是「有東西中」的次數 —— 後者是 0 才是問題,
   * 前者為 0 才代表這條規則的觸發路徑根本沒被走到(例如這個頁面沒有 range)。
   */
  const tally: Record<string, number> = Object.create(null)
  /** 把最後一筆 tally 推進去。刻意在回傳前才加,不影響任何既有消費端 */
  const pushTally = (): void => {
    out.push({ kind: '__tally', text: JSON.stringify(tally) })
  }
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
  /**
   * 從 CSSOM 讀 range 軌道高度(px),讀不到回 null。
   *
   * 與模組層級的 trackHeightFromCssom 同語意,這裡刻意內聯(見檔頭序列化契約第 1 條)。
   * 為什麼不能用 getComputedStyle(偽元素):實測它一律回傳**元素**的高度 ——
   * 軌道 2/4/6px 三次都拿到 28px,而且不報錯。細節見模組層級那個函式。
   */
  const trackHeightCssomInner = (el: Element): number | null => {
    let sheets: StyleSheetList
    try {
      sheets = document.styleSheets
    } catch {
      return null
    }
    let bestPx: number | null = null
    let bestSpec = -1
    for (let i = 0; i < sheets.length; i++) {
      let rules: CSSRuleList
      try {
        rules = sheets[i].cssRules
      } catch {
        continue
      }
      for (let j = 0; j < rules.length; j++) {
        const rule = rules[j] as CSSStyleRule
        const sel = rule.selectorText
        if (!sel || !rule.style) continue
        for (const part of sel.split(',')) {
          const s = part.trim()
          const pseudo = '::-webkit-slider-runnable-track'
          if (!s.endsWith(pseudo)) continue
          const base = s.slice(0, -pseudo.length).trim()
          if (base === '' || base === '*') continue
          let hit = false
          try {
            hit = el.matches(base)
          } catch {
            hit = false
          }
          if (!hit) continue
          const px = parseFloat(rule.style.height)
          if (!Number.isFinite(px) || px <= 0) continue
          const spec = base.charAt(0) === '#' ? 100 : base.charAt(0) === '.' ? 10 : base.indexOf('[') >= 0 ? 5 : 1
          if (spec > bestSpec) {
            bestSpec = spec
            bestPx = px
          }
        }
      }
    }
    return bestPx
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
        tally['low-contrast'] = (tally['low-contrast'] || 0) + 1
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
      tally['tiny-text'] = (tally['tiny-text'] || 0) + 1
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
    //    排除:label 內的輸入框(點文字同樣有效)。
    //
    //    range **不走這條**(改由 3b 的 thin-slider 量軌道):元素高度是命中帶,
    //    而軌道才是「滑鼠瞄不瞄得到」的那個東西。見 3b 的註解。
    const type = (el.getAttribute('type') || '').toLowerCase()
    const isRange = el.tagName === 'INPUT' && type === 'range'
    const inLabel = !!el.closest('label')
    const clickable =
      el.matches('button, a, [role="button"]') ||
      (el.matches('input, select, textarea') && !inLabel)
    if (clickable && !inLabel && !isRange) {
      tally['small-tap-target'] = (tally['small-tap-target'] || 0) + 1
      const tooSmall = r.width < 28 || r.height < 28
      if (tooSmall) {
        const key = 'tap:' + el.tagName + ':' + type + ':' + Math.round(r.width) + 'x' + Math.round(r.height)
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'small-tap-target',
            text: `<${el.tagName.toLowerCase()}${type ? ' type=' + type : ''}> ${Math.round(r.width)}x${Math.round(r.height)} class="${String(el.className).slice(0, 50)}"`
          })
        }
      }
    }

    // 3b. range 軌道細到瞄不準。
    //
    //    **這一條曾經是壞的,而且從未觸發過。修它時又差點壞第二次。**
    //
    //    歷史:原本寫成 `isRange ? r.height < 8 : ...`,而 `r` 是**元素**的
    //    boundingRect —— 那是命中帶,不是軌道。range 元素高度在 P2-2 被從
    //    22px 改成 28px,所以從那之後 `28 < 8` 永不成立。而宣稱要量的
    //    軌道是偽元素,getBoundingClientRect 量不到。
    //
    //    第一版修正改成 `getComputedStyle(el, '::-webkit-slider-runnable-track')`
    //    —— **那也是壞的**:實測(2026-10-05,真實 Chromium)該行不管軌道設成
    //    2px / 4px / 6px 一律回傳 "28px"(元素高度),帶引號寫法與
    //    getPropertyValue 也一樣。它**不報錯、不警告**,所以看起來在工作。
    //    這就是「換了一條同樣不會觸發的規則」。
    //
    //    現在走 CSSOM:document.styleSheets → cssRules → 找綁到這個元素的
    //    ::-webkit-slider-runnable-track 規則,讀它的 style.height。同一組
    //    實測下 CSSOM 正確回傳 2 / 4 / 6。讀不到就當沒有軌道 → 不報。
    //
    //    門檻 3px 的來由(**先量過才定**):這個專案的滑桿軌道真實高度是 4px
    //    (global.css),而那是被 P2-2 刻意保留的視覺 —— 元素 28px 當命中帶、
    //    軌道 4px 畫線,兩者分工不同。門檻必須低於「已知良好」的 4px,否則六個
    //    滑桿會全部被報,而把正確設計回報成缺陷是這個專案拒絕做的事。
    //    2px 在深色背景上就幾乎看不見,那才是真的值得報。
    if (isRange) {
      tally['thin-slider'] = (tally['thin-slider'] || 0) + 1
      const trackH = trackHeightCssomInner(el)
      if (trackH !== null && trackH > 0 && trackH < 3 && r.width > 0) {
        const key = 'thin:' + Math.round(r.width) + 'x' + trackH
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'thin-slider',
            text: `<input type="range"> 軌道 ${trackH}px(下限 3px;命中帶 ${Math.round(r.height)}px 正常)class="${String(el.className).slice(0, 50)}"`
          })
        }
      }
    }

    // 2b. 包住表單控制項的 <label> 過小。
    //     規則 2 刻意略過 label 內的輸入框(因為真實命中區是整個 label),
    //     所以 label 自己變小時這裡是唯一的看守。與 isSmallLabelTarget 同語意,
    //     內聯是為遵守檔頭的序列化契約。量測對象是 label 本身(下方的 each
    //     走的是同一批元素,所以這裡只認 LABEL 標籤)。
    if (el.tagName === 'LABEL') {
      tally['small-label-target'] = (tally['small-label-target'] || 0) + 1
      const owns = el.querySelector('input, select, textarea')
      const text = (el.textContent ?? '').trim()
      const labelled = text.length > 0 || !!el.getAttribute('title')
      if (owns && labelled && r.height < 28) {
        const key = 'label:' + Math.round(r.width) + 'x' + Math.round(r.height)
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'small-label-target',
            text: `<label> ${Math.round(r.width)}x${Math.round(r.height)} 包住 <${owns.tagName.toLowerCase()}> "${text.slice(0, 24)}"`
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
    tally['clipped'] = (tally['clipped'] || 0) + 1
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
    tally['truncated-no-label'] = (tally['truncated-no-label'] || 0) + 1
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
    //
    //    `!inLabel` 這個排除**不再是無條件的**。原本的寫法是
    //    `el.matches(...) && !inLabel`,理由是「在 label 裡 → label 提供名稱」。
    //    但那只在 label **有文字或 title** 時成立。實測過的反例:
    //    `<label><input type="checkbox"></label>` —— label 沒有任何文字,
    //    沒有 aria-label,input 也沒有,於是螢幕閱讀器拿到的是**空名稱**,
    //    而規則因為「它在 label 裡」而略過 —— 沒有任何人報。
    //    與 small-label-target 是同一族問題:為了不誤報而做的排除,自己變成了一個
    //    結構性的盲區。
    //
    //    所以改成:只有在 label **真的提供得到名字**時才略過。
    //    labelText 是上面為了 small-label-target 算過的同一個值,不重複算。
    if (el.matches('button, a, input, select, textarea')) {
      tally['no-accessible-name'] = (tally['no-accessible-name'] || 0) + 1
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
      // label 裡的表單控制項:名稱來自 label 的文字。label 沒文字 → 沒有名稱。
      const ownerLabel = el.closest('label')
      const nameFromLabel = ownerLabel
        ? (ownerLabel.textContent || '').trim() || (ownerLabel.getAttribute('title') || '').trim()
        : ''
      const skippedByLabel = !!inLabel && nameFromLabel.length > 0
      if (!name && !implicit && !skippedByLabel) {
        const key = 'anon:' + el.tagName + ':' + String(el.className).slice(0, 40)
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'no-accessible-name',
            text: `<${el.tagName.toLowerCase()}${type2 ? ' type=' + type2 : ''}>` +
              (inLabel ? ' 包在**沒有文字**的 <label> 裡,無障礙名稱為空' : '') +
              ` class="${String(el.className).slice(0, 60)}"`
          })
        }
      }
    }

    // 8. 橫向捲動容器。桌面 App 裡意外的橫向捲動幾乎都是版面 bug,
    //    但「刻意讓工具列橫向捲動」是合理設計。工具無法分辨意圖,
    //    所以提供 data-allow-h-scroll 明確宣告例外,而不是在這裡猜。
    const ox = cs.overflowX
    if (ox === 'auto' || ox === 'scroll') tally['h-overflow-container'] = (tally['h-overflow-container'] || 0) + 1
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
    tally['text-covered'] = (tally['text-covered'] || 0) + 1
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
    tally['animation-unsettled'] = (tally['animation-unsettled'] || 0) + 1
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

  pushTally()
  return out
}
