import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitDomFindings, createReport } from '../audit-report.mjs'

/**
 * 規則計數(tally)的正確性測試。
 *
 * 為什麼值得單獨一組測:`thin-slider` 存在了三輪、看起來在工作,卻一次都沒
 * 觸發過 —— 而「問題 0 筆」正是它在報告裡的樣子。計數機制就是為了讓這種
 * 情況浮出來,所以它本身的正確性不能靠「跑看看有沒有壞」。
 *
 * 最關鍵的一條是「__tally 不會被當成問題」:如果它被算進去,問題數會憑空 +1,
 * 而問題數是 release-gate 的基線 —— 那會讓基線失真,而且看起來像真的有問題。
 */
describe('splitDomFindings', () => {
  it('把 __tally 從問題裡拿掉,只留在 tally', () => {
    const dom = [
      { kind: 'small-tap-target', text: '<button> 20x20' },
      { kind: '__tally', text: JSON.stringify({ 'small-tap-target': 12, 'thin-slider': 3 }) }
    ]
    const { problems, tally } = splitDomFindings(dom)
    expect(problems).toHaveLength(1)
    expect(problems[0].kind).toBe('small-tap-target')
    expect(tally).toEqual({ 'small-tap-target': 12, 'thin-slider': 3 })
  })

  it('tally 的位置不影響(它在最後,但實作不依賴順序)', () => {
    const dom = [
      { kind: '__tally', text: '{"a":1}' },
      { kind: 'clipped', text: 'x' }
    ]
    const { problems, tally } = splitDomFindings(dom)
    expect(problems).toHaveLength(1)
    expect(tally).toEqual({ a: 1 })
  })

  it('沒有 tally 時回 null 而不是拋錯(舊的 domAudit 呼叫端仍要能用)', () => {
    const { problems, tally } = splitDomFindings([{ kind: 'clipped', text: 'x' }])
    expect(tally).toBeNull()
    expect(problems).toHaveLength(1)
  })

  it('tally 是壞 JSON 時不拋錯,只是當成沒有(量測端不該因為報告而崩)', () => {
    const dom = [{ kind: 'clipped', text: 'x' }, { kind: '__tally', text: '{not json' }]
    const { problems, tally } = splitDomFindings(dom)
    expect(tally).toBeNull()
    expect(problems).toHaveLength(1)
  })

  it('undefined / null 輸入不會崩', () => {
    expect(splitDomFindings(undefined).problems).toEqual([])
    expect(splitDomFindings(null).problems).toEqual([])
  })

  it('tally 的計數為 0 時要保留(那正是「從未評估」的訊號)', () => {
    const { tally } = splitDomFindings([{ kind: '__tally', text: '{"thin-slider":0}' }])
    // 0 不能被當成 falsy 丟掉 —— 整個機制的目的就是看見 0
    expect(tally).toEqual({ 'thin-slider': 0 })
    expect('thin-slider' in (tally ?? {})).toBe(true)
  })
})

describe('report.tallyRule', () => {
  /**
   * tallyRule 沒有 getter,所以只能從 finish 寫出的 payload 讀回。
   * 寫到暫存檔再讀,而不是只在 console 裡看 —— console 不會被斷言。
   */
  function tallyOf(r) {
    const dir = mkdtempSync(join(tmpdir(), 'tally-'))
    const file = join(dir, 'r.json')
    try {
      r.finish(file)
      return JSON.parse(readFileSync(file, 'utf-8')).meta.ruleTally
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('多次併入同一條規則會累加,而不是覆蓋', () => {
    const r = createReport('test-tool')
    r.tallyRule({ 'thin-slider': 5 })
    r.tallyRule({ 'thin-slider': 3 })
    r.tallyRule({ 'small-tap-target': 7 })
    expect(tallyOf(r)).toEqual({ 'thin-slider': 8, 'small-tap-target': 7 })
  })

  it('支援單筆 +1 的簽名', () => {
    const r = createReport('test-tool')
    r.tallyRule('clipped')
    r.tallyRule('clipped')
    expect(tallyOf(r)).toEqual({ clipped: 2 })
  })

  it('壞掉的計數值不會讓整份報告崩掉(NaN / 字串 / null)', () => {
    const r = createReport('test-tool')
    r.tallyRule({ a: NaN, b: '5', c: null, d: undefined, e: 2 })
    // 關鍵是不拋錯:finish 會把 ruleTally 放進 payload,崩在這裡就沒有報告了
    let out = null
    expect(() => {
      out = tallyOf(r)
    }).not.toThrow()
    // NaN/undefined/null 應該被當成 0,字串數字被強制轉換
    expect(out.a).toBe(0)
    expect(out.b).toBe(5)
    expect(out.e).toBe(2)
  })

  it('沒有任何 tally 時 finish 仍然正常', () => {
    const r = createReport('test-tool')
    r.measured('state-a')
    expect(() => r.finish()).not.toThrow()
    expect(r.length).toBe(0)
  })

  it('tally 本身不算問題(問題數不因 tally 增加)', () => {
    const r = createReport('test-tool')
    r.tallyRule({ 'thin-slider': 0 })
    r.measured('state-a')
    r.finish()
    expect(r.length, 'tally 不該讓問題數增加').toBe(0)
  })

  it('計數為 0 的規則會保留在 payload 裡(那正是要看的訊號)', () => {
    const r = createReport('test-tool')
    r.tallyRule({ 'thin-slider': 0, clipped: 4 })
    const out = tallyOf(r)
    expect('thin-slider' in out).toBe(true)
    expect(out['thin-slider']).toBe(0)
  })
})
