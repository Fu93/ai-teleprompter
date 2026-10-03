/**
 * release-checks.test.mjs — 發布前兩條不變量的單元測試。
 *
 * 為什麼值得用測試守:這兩條規則**只會在發布前才會被執行**,所以一個寫錯的規則
 * 在本地要等到真的發布才會現形 —— 那正是最貴的發現時機(版本號已經印在安裝檔上)。
 *
 * 每條規則都有負向案例:把它寫成「永遠通過」的版本,這些測試當場就紅。
 */
import { describe, expect, it } from 'vitest'
import { summarizeProdAudit, checkVersionConsistency } from '../release-checks.mjs'

describe('summarizeProdAudit', () => {
  it('production 依賴乾淨時回 0(現在的真實狀態)', () => {
    expect(summarizeProdAudit({ vulnerabilities: {} }).total).toBe(0)
  })

  it('有漏洞時列出依賴名稱與嚴重度分類', () => {
    const r = summarizeProdAudit({
      vulnerabilities: {
        'some-runtime-lib': { severity: 'high' },
        'another-lib': { severity: 'moderate' },
        'third-lib': { severity: 'high' }
      }
    })
    expect(r.total).toBe(3)
    expect(r.names).toEqual(['another-lib', 'some-runtime-lib', 'third-lib'])
    expect(r.severity).toEqual({ high: 2, moderate: 1 })
  })

  it('輸入損壞時回「0 個」而不是拋錯 —— 閘門不能因為報告壞掉就整個崩掉', () => {
    expect(summarizeProdAudit(null).total).toBe(0)
    expect(summarizeProdAudit({}).total).toBe(0)
    expect(summarizeProdAudit('nope').total).toBe(0)
  })
})

describe('checkVersionConsistency', () => {
  const good = ['## [Unreleased]', '說明', '## [0.2.0] - 2026-09-28', '內容', '## [0.1.0] - 2026-09-27'].join(
    '\n'
  )

  it('一致時通過', () => {
    expect(checkVersionConsistency('0.2.0', good)).toEqual([])
  })

  it('package.json 與 CHANGELOG 不同版本 → 紅燈並說出兩個版本', () => {
    const problems = checkVersionConsistency('0.2.1', good)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('0.2.1')
    expect(problems[0]).toContain('0.2.0')
  })

  it('最新段落沒有日期 → 紅燈', () => {
    const problems = checkVersionConsistency('0.2.0', '## [Unreleased]\n## [0.2.0]\n內容')
    expect(problems.some((p) => p.includes('日期'))).toBe(true)
  })

  it('只有 [Unreleased](還沒發過任何一版)→ 紅燈', () => {
    const problems = checkVersionConsistency('0.2.0', '## [Unreleased]\n還在寫')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('沒有任何已發布版本')
  })

  it('比對的是**最新**那一段,不是任一段(舊段落相同不算通過)', () => {
    const problems = checkVersionConsistency('0.1.0', good)
    expect(problems.some((p) => p.includes('版本不一致'))).toBe(true)
  })

  it('CHANGELOG 內容損壞時不會誤判成通過', () => {
    expect(checkVersionConsistency('0.2.0', '').length).toBeGreaterThan(0)
  })
})