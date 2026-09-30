import { describe, expect, it, vi } from 'vitest'
import { MIN_TAP_PX, SMALL_TARGET_SELECTOR, domAudit, isSmallTarget } from '../domAudit'

/**
 * domAudit 會被 Playwright 的 `page.evaluate(domAudit)` 序列化後送進頁面執行,
 * 序列化的內容是 `Function.prototype.toString()`。這個檔案存在的唯一目的,
 * 就是讓「不小心加了型別標註」或「把常數抽出去共用」這兩種改動**當場變紅**,
 * 而不是等到某次稽核悄悄壞掉、報告變成一份沒人敢相信的空清單。
 */
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
