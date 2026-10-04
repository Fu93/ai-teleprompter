import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { MIN_TAP_PX, SMALL_TARGET_SELECTOR, domAudit, isSmallTarget, settleAnimations } from '../domAudit'

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

  it('空文件下可獨立執行並回傳空陣列(證明沒有依賴未被序列化的外部狀態)', () => {
    vi.stubGlobal('document', { querySelectorAll: () => [] as unknown[] })
    try {
      expect(domAudit()).toEqual([])
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
