import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  MIN_TAP_PX,
  SMALL_TARGET_SELECTOR,
  domAudit,
  isSmallTarget,
  isSmallLabelTarget,
  isThinTrack,
  settleAnimations
} from '../domAudit'

/** 專案根目錄:src/renderer/src/lib/__tests__ → 五層上來(這個測試讀的是 scripts/) */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/**
 * domAudit 會被 Playwright 的 `page.evaluate(domAudit)` 序列化後送進頁面執行,
 * 序列化的內容是 `Function.prototype.toString()`。這個檔案存在的唯一目的,
 * 就是讓「不小心加了型別標註」或「把常數抽出去共用」這兩種改動**當場變紅**,
 * 而不是等到某次稽核悄悄壞掉、報告變成一份沒人敢相信的空清單。
 */
/**
 * settleAnimations 的契約。這個函式是為了修一個**量測端**的缺陷:
 * animation-unsettled 會在取樣當下撞上 transition 的尾巴時誤報(實測三跑一紅),
 * 修法是讓取樣發生在動畫結束之後。規則本身沒有放寬,所以這裡測的是
 * 「等對的東西、等多久、而且不放棄」三件事。
 */
describe('settleAnimations(量測前先讓動畫收斂)', () => {
  interface FakeOpts {
    playState?: string
    iterations?: number
    /** null = 永遠不收斂 */
    finishMs?: number | null
  }
  /** 假動畫的最小形狀:domAudit 與 settleAnimations 只用到這幾樣。 */
  interface FakeAnim {
    playState: string
    effect: { getComputedTiming: () => { iterations: number } }
    finished: Promise<void>
    settled: () => boolean
  }

  /** 做一顆假的動畫。finished resolve 之後會把 playState 改成 finished,跟真實動畫一致。 */
  const fakeAnim = (opts: FakeOpts): FakeAnim => {
    let resolveFinished: () => void = () => {}
    const finished = new Promise<void>((r) => {
      resolveFinished = r
    })
    const o: FakeAnim = {
      playState: opts.playState ?? 'running',
      effect: { getComputedTiming: () => ({ iterations: opts.iterations ?? 1 }) },
      finished,
      settled: () => o.playState === 'finished'
    }
    if (opts.finishMs === null) {
      // 永遠不收斂:promise 永不 resolve
    } else {
      setTimeout(() => {
        o.playState = 'finished'
        resolveFinished()
      }, opts.finishMs ?? 0)
    }
    return o
  }

  const withDocument = async (anims: FakeAnim[], fn: () => Promise<void>) => {
    vi.stubGlobal('document', { getAnimations: () => anims })
    try {
      await fn()
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it('有限次且正在跑的動畫:等到它真的收斂之後才返回', async () => {
    const a = fakeAnim({ finishMs: 10 })
    await withDocument([a], async () => {
      await settleAnimations(200, 1)
      expect(a.settled(), 'settleAnimations 應該等到動畫跑完').toBe(true)
    })
  })

  it('常駐動畫(iterations === Infinity)不等 —— 它本來就不該收斂', async () => {
    const spin = fakeAnim({ iterations: Infinity, finishMs: 5000 })
    await withDocument([spin], async () => {
      const t0 = Date.now()
      await settleAnimations(200, 1)
      // 真的等了 200ms 上限就代表它把常駐動畫也放進 pending 了
      expect(Date.now() - t0).toBeLessThan(150)
      expect(spin.settled()).toBe(false)
    })
  })

  it('收斂不了的動畫不會讓量測永久卡住:上限到了就返回', async () => {
    const stuck = fakeAnim({ finishMs: null })
    await withDocument([stuck], async () => {
      const t0 = Date.now()
      await settleAnimations(30, 1)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(20)
      expect(Date.now() - t0).toBeLessThan(1000)
    })
  })

  it('頁面沒有 getAnimations(舊環境)時安靜返回,不拋', async () => {
    vi.stubGlobal('document', {})
    try {
      await expect(settleAnimations(30, 1)).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * 接線的守衛:規則語意沒變,變的是**取樣時機**。如果有人只加了 settleAnimations
 * 卻忘了在某支稽核腳本裡呼叫它,這個函式就是死碼,而誤報會回來 —— 而且是
 * 間接地回來(下一次看到 animation-unsettled 只會以為自己改壞了什麼)。
 */
describe('取樣前必須先 settle(接線不是可選的)', () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

  for (const script of ['scripts/audit-deep.mjs', 'scripts/audit-states.mjs', 'scripts/audit-ui.mjs']) {
    it(`${script}:每次 evaluate(domAudit) 之前都有 evaluate(settleAnimations)`, () => {
      const src = read(script)
      expect(src, `${script} 應該匯入 settleAnimations`).toContain('evaluate(settleAnimations)')
      const measures = [...src.matchAll(/evaluate\(domAudit\)/g)].map((m) => m.index ?? 0)
      const settles = [...src.matchAll(/evaluate\(settleAnimations\)/g)].map((m) => m.index ?? 0)
      expect(measures.length, `${script} 應該至少量一次 domAudit`).toBeGreaterThan(0)
      for (const at of measures) {
        const before = settles.filter((s) => s < at)
        expect(
          before.length > 0,
          `${script}:在第 ${at} 個字元處的 evaluate(domAudit) 之前沒有任何 settleAnimations —— 取樣會撞上過渡態`
        ).toBe(true)
      }
      // 也要守住序列化檢查:settleAnimations 同樣會被送進頁面執行
      expect(src, `${script} 應該用 guardSerializable 驗過 settleAnimations`).toContain(
        'guardSerializable(settleAnimations'
      )
    })
  }
})

describe('domAudit 序列化契約', () => {
  it('原始碼可以被 new Function 解析(函式內沒有 TS 型別標註)', () => {
    const src = domAudit.toString()
    expect(() => new Function(`return (${src})`)).not.toThrow()
  })

  it('原始碼不引用任何模組層級識別字', () => {
    const src = domAudit.toString()
    // 這些名字在模組頂層,不會跟著函式被序列化;函式內一提到就是 undefined。
    // 門檻與 selector 必須在函式內以字面值/字面字串存在。
    for (const name of ['MIN_TAP_PX', 'MIN_FONT_PX', 'SMALL_TARGET_SELECTOR', 'isSmallTarget']) {
      expect(src, `domAudit 內不應出現模組層級的 ${name}`).not.toContain(name)
    }
  })

  it('函式內仍保有與模組層級一致的門檻字面值', () => {
    const src = domAudit.toString()
    // 命中區門檻必須是字面值 —— 引用 MIN_TAP_PX 會在頁面裡變成 undefined
    expect(src).toContain(`r.width < ${MIN_TAP_PX} || r.height < ${MIN_TAP_PX}`)
    // 字級下限同理
    expect(src).toContain('< 10')
    // label 內輸入框的排除條件、range 的軌道高度門檻
    // (不檢查引號樣式:經過 transform 之後字串引號會被正規化,那不重要)
    expect(src).toContain('closest')
    expect(src).toContain('range')
  })

  /**
   * 空文件下可獨立執行,且**不產任何問題**(證明沒有依賴未被序列化的外部狀態)。
   *
   * 這條斷言在 2026-10-05 改過一次:回傳值多了一筆 `__tally`(規則計數),
   * 所以「toEqual([])」不再成立。但**不能**把它改成 `toEqual([tally])` ——
   * 那只是換一個寫法來配合現況。真正要守的是「沒有東西壞掉」,所以這裡
   * 斷言**問題數為 0**,並另外確認 tally 存在且是合法 JSON。
   *
   * 順帶值得記錄:這條測試紅掉的第一反應很容易是「把 tally 去掉」,
   * 而那正好會把剛加的機制殺掉。改測試之前先問「行為變了還是測試過時了」。
   */
  it('空文件下可獨立執行,且不產任何問題', () => {
    vi.stubGlobal('document', { querySelectorAll: () => [] as unknown[] })
    try {
      const out = domAudit()
      const problems = out.filter((f) => f.kind !== '__tally')
      expect(problems).toEqual([])
      const tallyEntry = out.find((f) => f.kind === '__tally')
      expect(tallyEntry, '規則計數必須永遠存在 —— 空頁面也是').toBeDefined()
      expect(() => JSON.parse(tallyEntry!.text)).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('tally 是最後一筆(消費端可以無腦取最後一個)', () => {
    vi.stubGlobal('document', { querySelectorAll: () => [] as unknown[] })
    try {
      const out = domAudit()
      expect(out[out.length - 1]?.kind).toBe('__tally')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('共用門檻', () => {
  it('MIN_TAP_PX 是 28(離線稽核與除錯面板必須同一個數值)', () => {
    expect(MIN_TAP_PX).toBe(28)
  })

  it('SMALL_TARGET_SELECTOR 涵蓋 button/a/role=button/表單控制項', () => {
    for (const part of ['button', 'a', '[role="button"]', 'input', 'select', 'textarea']) {
      expect(SMALL_TARGET_SELECTOR).toContain(part)
    }
  })

  it('isSmallTarget 對不是候選元素的節點直接回 false(不會誤報)', () => {
    const el = {
      matches: () => false,
      closest: () => null,
      getBoundingClientRect: () => ({ width: 1, height: 1 })
    } as unknown as Element
    expect(isSmallTarget(el)).toBe(false)
  })
})

/**
 * isSmallLabelTarget — 補上「輸入框被略過、但 label 自己太小」這個盲區。
 *
 * 為什麼這組值得存在:isSmallTarget 對 label 內的輸入框回 false(正確 —— 觸控目標
 * 是整個 label),而那個「正確」同時意味著 label 變小時沒有任何人報。第四輪 P2-1
 * 的兩個音訊來源勾選就是這樣活下來的:當時所有稽核都綠。
 */
describe('isSmallLabelTarget', () => {
  function label(opts: {
    height: number
    width?: number
    tag?: string
    owns?: boolean
    text?: string
    title?: string | null
  }): Element {
    return {
      tagName: opts.tag ?? 'LABEL',
      textContent: opts.text ?? '我的麥克風',
      getAttribute: (n: string) => (n === 'title' ? (opts.title ?? null) : null),
      querySelector: () => (opts.owns === false ? null : { tagName: 'INPUT' }),
      getBoundingClientRect: () => ({ width: opts.width ?? 113, height: opts.height })
    } as unknown as Element
  }

  it('包住控制項、高度 20px → 判定過小(這是第四輪 P2-1 的實測值)', () => {
    expect(isSmallLabelTarget(label({ height: 20 }))).toBe(true)
  })

  it('同樣寬度但高度 28px → 放行(邊界含 28)', () => {
    expect(isSmallLabelTarget(label({ height: 28 }))).toBe(false)
  })

  it('不是 label → 回 false', () => {
    expect(isSmallLabelTarget(label({ height: 20, tag: 'DIV' }))).toBe(false)
  })

  it('沒有包住任何控制項的 label(純版面)→ 回 false', () => {
    expect(isSmallLabelTarget(label({ height: 20, owns: false }))).toBe(false)
  })

  it('既無文字也無 title(純空間)→ 回 false,避免規則變成發報機', () => {
    expect(isSmallLabelTarget(label({ height: 20, text: '', title: null }))).toBe(false)
  })

  it('無文字但有 title → 仍算可點擊區(它有可見的說明)', () => {
    expect(isSmallLabelTarget(label({ height: 20, text: '', title: '說明' }))).toBe(true)
  })

  it('不可見(0×0,例如在隱藏的頁面裡)→ 回 false,不報幽靈問題', () => {
    expect(isSmallLabelTarget(label({ height: 0 }))).toBe(false)
  })

  /**
   * 這組是互斥性保證:label 內的輸入框與 label **本身**只會被報一次。
   * 若兩個規則都報,同一個缺陷會在報告裡出現兩筆 —— 那會讓「問題數」
   * 這個指標失真(而且稽核閘門是拿它當基準的)。
   */
  it('輸入框與它的 label 不會被重複判定', () => {
    const input = {
      matches: (s: string) => s.includes('input'),
      closest: () => label({ height: 20 }),
      getAttribute: () => 'checkbox',
      getBoundingClientRect: () => ({ width: 13, height: 13 })
    } as unknown as Element
    // 13x13 的輸入框:被 isSmallTarget 略過(真實命中區是 label)…
    expect(isSmallTarget(input)).toBe(false)
    // …而由 label 那一側報一次。
    expect(isSmallLabelTarget(input.closest('label')!)).toBe(true)
  })

  it('domAudit 序列化後仍保有 label 規則(不會因為引用模組層級常數而失效)', () => {
    const src = domAudit.toString()
    expect(src).toContain('small-label-target')
    // 序列化契約:不得引用模組層級識別字
    expect(src).not.toContain('MIN_TAP_PX')
  })
})

/**
 * 除錯層與離線稽核的**接線測試**。
 *
 * 為什麼需要:LayoutDebugLayer 的檔頭寫著「規則與離線稽核完全同一份」,但它只掃
 * SMALL_TARGET_SELECTOR(不含 label)。所以新增 small-label-target 規則時,
 * 離線稽核會報、除錯面板不會 —— 而那句「完全同一份」的宣稱就變成假的。
 *
 * 這是這個 repo 記錄過的模式(見 audit-effects 的接線測試:「只加函式卻忘記在某支
 * 腳本裡呼叫,測試會紅」)。規則本身有測試並不夠 —— 一個沒被接上線的正確規則,
 * 與沒有規則在效果上是同一件事。
 *
 * 這裡讀原始碼而非真的跑 DOM:LayoutDebugLayer 是 React 元件,在 node 環境下
 * 渲染它需要的東西遠多於這條規則該有的成本。而這條規則要擋的缺陷是
 * 「忘了呼叫」—— 原始碼層的證據對這一點是足夠的,且不會隨元件重構而失效。
 */
describe('除錯層與離線稽核的規則接線', () => {
  const LAYER = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'components', 'LayoutDebugLayer.tsx'
  )

  it('LayoutDebugLayer 有標記 label 的命中區(與 offline small-label-target 對齊)', () => {
    const src = readFileSync(LAYER, 'utf-8')
    expect(src, '除錯層必須 import isSmallLabelTarget').toContain('isSmallLabelTarget')
    // 而且必須真的呼叫它 —— 只 import 不呼叫是無效接線
    expect(src, '除錯層必須真的呼叫 isSmallLabelTarget').toMatch(/if\s*\(\s*isSmallLabelTarget\(el\)\s*\)/)
  })

  it('除錯層也標記 thin track(isThinTrack 的接線)', () => {
    const src = readFileSync(LAYER, 'utf-8')
    expect(src, '除錯層必須 import isThinTrack').toContain('isThinTrack')
    expect(src, '除錯層必須真的呼叫 isThinTrack').toMatch(/isThinTrack\(el\)/)
  })

  it('除錯層與離線稽核共用同一個屬性名(兩邊要能指到同一個元素)', () => {
    const layer = readFileSync(LAYER, 'utf-8')
    const audit = domAudit.toString()
    expect(layer).toContain('data-dbg-small')
    // 離線稽核不寫 data-* (它是回傳報告),但它報的 kind 必須是規則名稱
    expect(audit).toContain('small-label-target')
    expect(audit).toContain('thin-slider')
  })

  it('LayoutDebugLayer 的 clearTags 會把 label 的標記一起清掉', () => {
    const src = readFileSync(LAYER, 'utf-8')
    // 漏了會導致:使用者修好 label 後除錯面板仍顯示紅標,直到重掃。
    // 這是那種「以為沒生效就重開 App」的缺陷。
    expect(src, 'clearTags 必須同時清除 data-dbg-small').toMatch(
      /querySelectorAll\('\[data-dbg-small\]/
    )
  })
})

/**
 * isThinTrack —— 修掉一條**從未觸發過**的規則。
 *
 * 背景:規則宣稱「range 軌道 < 8px 就報」,但實作的 `isRange ? r.height < 8`
 * 量的是**元素**的 boundingRect。而 range 的元素高度是命中帶,第四輪 P2-2
 * 把它從 22px 改成 28px —— 從那之後 `28 < 8` 永遠不成立。
 * 而且軌道是 `::-webkit-slider-runnable-track` 偽元素,getBoundingClientRect
 * 根本量不到它。
 *
 * 實測(2026-10-05,在真實 Chromium 上量):軌道 2px 的 range,
 * 元素高度仍是 28px → 舊規則 wouldReport = false。而且 docs/audit 底下每一份
 * report.json 裡都沒有出現過 thin-slider —— 證明它一次都沒抓到過東西。
 *
 * 這組測試的價值不只是「規則現在對了」,而是**防止同型問題再次發生**:
 * 一個看起來在工作、實際上永遠不觸發的規則,比沒有規則更危險。
 */
describe('isThinTrack(軌道才是瞄準的對象,不是元素)', () => {
  /**
   * 這個測試組經歷了一次真正的教訓,值得把過程寫下來。
   *
   * 第一版我 stub 了 `getComputedStyle`,讓它在收到偽元素選擇器時回傳軌道高度
   * —— **測試全綠**。但真實瀏覽器裡那行根本不管用:實測(Chromium)軌道 2/4/6px
   * 一律回傳 "28px"(元素高度),而且不報錯。也就是說第一版的測試是
   * **在測一個假世界**:它驗證了我以為的行為,而不是實際行為。
   *
   * 現在改成 stub `document.styleSheets`(CSSOM)—— 那才是規則真正讀的東西。
   * 所以這組測試至少能保證「規則讀的是 CSSOM」,而 CSSOM 在真實瀏覽器裡
   * 確實能讀到軌道高度(實測:2 / 4 / 6 全部正確)。
   */
  function rangeWith(trackPx: number | null, elHeightPx = 28, width = 200) {
    const el = {
      tagName: 'INPUT',
      id: 'probe',
      className: '',
      type: 'range',
      getAttribute: (n: string) => {
        if (n === 'type') return 'range'
        if (n === 'id') return 'probe'
        return null
      },
      getBoundingClientRect: () => ({ width, height: elHeightPx }),
      closest: () => null,
      matches: (s: string) => s === '#probe' || s === 'input' || s.includes('#probe')
    } as unknown as Element

    const sheets =
      trackPx === null
        ? []
        : [
            {
              cssRules: [
                {
                  selectorText: '#probe::-webkit-slider-runnable-track',
                  style: { height: `${trackPx}px` }
                }
              ]
            }
          ]
    vi.stubGlobal('document', { styleSheets: sheets })
    return { el }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('軌道 4px(本專案的已知良好值)→ 不報', () => {
    const { el } = rangeWith(4)
    expect(isThinTrack(el)).toBe(false)
  })

  it('軌道 2px(細到看不見)→ 報', () => {
    const { el } = rangeWith(2)
    expect(isThinTrack(el)).toBe(true)
  })

  it('軌道 0.5px → 報', () => {
    const { el } = rangeWith(0.5)
    expect(isThinTrack(el)).toBe(true)
  })

  it('門檻邊界:軌道 3px(剛好門檻)→ 不報', () => {
    const { el } = rangeWith(3)
    expect(isThinTrack(el)).toBe(false)
  })

  it('沒有自訂軌道(stylesheets 裡沒有該規則)→ 不報,寧可漏報也不誤報', () => {
    const { el } = rangeWith(null)
    expect(isThinTrack(el)).toBe(false)
  })

  /**
   * 反向保證:這條規則**讀 CSSOM,不是讀 getComputedStyle**。
   * 第一版的 bug 正是用了 getComputedStyle,而它在真實瀏覽器裡靜默退化。
   * 這條斷言把「用的是 CSSOM」釘住 —— 有人改回 getComputedStyle 就會紅。
   */
  it('讀的是 CSSOM 而不是 getComputedStyle(第一版的 bug 就是這裡)', () => {
    const { el } = rangeWith(2, 28)
    // 即使 getComputedStyle 完全不可用,規則仍然必須能判斷
    vi.stubGlobal('getComputedStyle', () => {
      throw new Error('規則不該依賴 getComputedStyle 量軌道')
    })
    expect(isThinTrack(el)).toBe(true)
  })

  /**
   * 萬用選擇器不算:無法確定它作用在哪個元素上,猜錯就是誤報。
   */
  it('萬用選擇器 *::-… 不算(無法確定作用對象)', () => {
    const el = {
      tagName: 'INPUT',
      id: '',
      className: '',
      getAttribute: (n: string) => (n === 'type' ? 'range' : null),
      getBoundingClientRect: () => ({ width: 200, height: 28 }),
      closest: () => null,
      matches: () => true
    } as unknown as Element
    vi.stubGlobal('document', {
      styleSheets: [
        {
          cssRules: [
            { selectorText: '*::-webkit-slider-runnable-track', style: { height: '1px' } }
          ]
        }
      ]
    })
    expect(isThinTrack(el)).toBe(false)
  })

  it('cross-origin 樣式表(cssRules 拋出)→ 跳過而不是崩潰', () => {
    const el = {
      tagName: 'INPUT',
      id: 'probe',
      getAttribute: (n: string) => (n === 'type' ? 'range' : n === 'id' ? 'probe' : null),
      getBoundingClientRect: () => ({ width: 200, height: 28 }),
      closest: () => null,
      matches: (s: string) => s.includes('#probe') || s === 'input'
    } as unknown as Element
    vi.stubGlobal('document', {
      styleSheets: [
        {
          get cssRules(): CSSRuleList {
            throw new Error('SecurityError: cross-origin')
          }
        }
      ]
    })
    expect(isThinTrack(el)).toBe(false)
  })

  it('不可見的 range(寬度 0)→ 回 false(不報幽靈問題)', () => {
    const { el } = rangeWith(2, 28, 0)
    expect(isThinTrack(el)).toBe(false)
  })

  it('不是 range(checkbox)→ 回 false', () => {
    const el = {
      tagName: 'INPUT',
      getAttribute: () => 'checkbox',
      getBoundingClientRect: () => ({ width: 13, height: 13 })
    } as unknown as Element
    vi.stubGlobal('document', { styleSheets: [] })
    expect(isThinTrack(el)).toBe(false)
  })

  it('非 INPUT → 回 false', () => {
    const el = { tagName: 'DIV', getAttribute: () => null } as unknown as Element
    vi.stubGlobal('document', { styleSheets: [] })
    expect(isThinTrack(el)).toBe(false)
  })

  /**
   * 反向保證:range 不會被小命中區規則報一次 —— 拆成兩條規則,避免同一個缺陷
   * 報兩次(報告的問題數是稽核閘門的基準)。
   */
  it('range 不會同時被當成 small-tap-target 與 thin-slider 報兩次', () => {
    const { el } = rangeWith(2, 4)
    expect(isSmallTarget(el)).toBe(false)
    expect(isThinTrack(el)).toBe(true)
  })

  it('domAudit 序列化後仍保有 thin-slider 規則,且不引用模組層級常數', () => {
    const src = domAudit.toString()
    expect(src).toContain('thin-slider')
    expect(src, '序列化契約:不得引用模組層級常數').not.toContain('MIN_TAP_PX')
    // 序列化後也必須走 CSSOM
    expect(src).toContain('cssRules')
  })
})

/**
 * 規則 5 的盲區:**為了不誤報而做的排除,自己變成了一個看不見缺陷的地方。**
 *
 * 原本規則 5 對「在 label 裡的控制項」一律略過(`&& !inLabel`),理由是
 * 「label 提供無障礙名稱」。那只在 label **有文字或 title** 時成立。
 * 實測過的反例(真實 DOM):
 *     <label><input type="checkbox"></label>
 * label.textContent 是空字串、沒有 aria-label、input 也沒有 ——
 * 螢幕閱讀器拿到的是**空名稱**,而規則因為「它在 label 裡」而略過。
 *
 * 這組測試同時是上一個 bug 的教訓:我第一版只寫了「規則現在對了」的斷言,
 * 負向驗證時發現**拿掉修正不會紅** —— 因為沒有任何一條斷言依賴那個排除條件
 * 的行為。所以這裡每一條都必須**明確斷言該報的要報、該略過的要略過**。
 */
describe('規則 5:空 label 內的控制項確實沒有無障礙名稱', () => {
  /**
   * 最小可用的 label+control 建模。回傳能餵給 domAudit 的元素形狀。
   * labelText 為空字串就是那個盲區情境。
   */
  function labelWrappedControl(opts: { labelText: string; labelTitle?: string }) {
    const ctrl = {
      parentElement: null,
      tagName: 'INPUT',
      childNodes: [],
      textContent: '',
      getAttribute: (n: string) => (n === 'type' ? 'checkbox' : null),
      closest: () => labelEl,
      matches: (s: string) => s.includes('input'),
      getBoundingClientRect: () => ({ width: 13, height: 13, left: 0, top: 0, right: 13, bottom: 13 }),
      hasAttribute: () => false,
      style: {}
    }
    const labelEl = {
      parentElement: null,
      tagName: 'LABEL',
      textContent: opts.labelText,
      getAttribute: (n: string) => (n === 'title' ? (opts.labelTitle ?? null) : null),
      querySelector: () => ctrl,
      childNodes: [],
      closest: () => null,
      matches: () => false,
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ width: 113, height: 32, left: 0, top: 0, right: 113, bottom: 32 }),
      style: {}
    }
    return { labelEl, ctrl }
  }

  /** 跑 domAudit 並只看 no-accessible-name */
  function runAudit(elements: unknown[]): Array<{ kind: string; text: string }> {
    // clipperOfInner 會一路往上走到 documentElement,所以那份 stub 也得是
    // 一個「看起來像元素」的東西 —— 否則規則 3 會先在它身上爆掉。
    const documentElement = {
      tagName: 'HTML',
      parentElement: null,
      getBoundingClientRect: () => ({
        width: 1200, height: 800, left: 0, top: 0, right: 1200, bottom: 800
      })
    }
    vi.stubGlobal('document', {
      documentElement,
      body: { tagName: 'BODY', parentElement: documentElement },
      getElementById: () => null,
      querySelectorAll: () => elements
    })
    vi.stubGlobal('getComputedStyle', (el: Element) => {
      const own = (el as unknown as { style?: Record<string, string> }).style ?? {}
      return {
        color: 'rgb(229,231,235)',
        backgroundColor: 'rgba(10,12,17,1)',
        fontSize: '14px',
        fontWeight: '400',
        display: own['display'] ?? 'block',
        visibility: 'visible',
        opacity: own['opacity'] ?? '1',
        overflow: own['overflow'] ?? 'visible',
        overflowX: own['overflowX'] ?? 'visible',
        overflowY: own['overflowY'] ?? 'visible'
      }
    })
    try {
      return domAudit() as Array<{ kind: string; text: string }>
    } finally {
      vi.unstubAllGlobals()
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('空 label 內的 checkbox → 報 no-accessible-name(這是修復前漏掉的那一個)', () => {
    const { labelEl, ctrl } = labelWrappedControl({ labelText: '' })
    const findings = runAudit([labelEl, ctrl])
    const anon = findings.filter((f) => f.kind === 'no-accessible-name')
    expect(anon.length, '空的 label 不提供無障礙名稱,這個 checkbox 必須被報').toBe(1)
    expect(anon[0].text).toContain('label')
  })

  it('有文字的 label 內的 checkbox → 不報(label 確實提供了名稱)', () => {
    const { labelEl, ctrl } = labelWrappedControl({ labelText: '我的麥克風' })
    const findings = runAudit([labelEl, ctrl])
    expect(findings.filter((f) => f.kind === 'no-accessible-name').length).toBe(0)
  })

  it('無文字但有 title 的 label → 不報(title 也是可存取名稱)', () => {
    const { labelEl, ctrl } = labelWrappedControl({ labelText: '', labelTitle: '關閉提示' })
    const findings = runAudit([labelEl, ctrl])
    expect(findings.filter((f) => f.kind === 'no-accessible-name').length).toBe(0)
  })
})
