/**
 * report-guard.test.mjs — 「被破壞的稽核報告」備份／還原的負向驗證。
 *
 * 為什麼這條檔案存在:audit:selftest 會把真的 report.json 改名成備份,
 * 帶著破壞跑一次稽核,再改名回去。這個設計的前提是「一定會還原」。
 *
 * 實測踩過的前提失效:執行被逾時砍掉之後,磁碟上留下的是備份而 report.json
 * 不見了。而 release-gate 的分母是「報告裡有幾個狀態」—— 讀不到報告時,
 * 那條規則的行為不等於「通過」。也就是說**量測層自己壞掉時不會有東西報錯**,
 * 這是這個專案記錄過最貴的一類失效。
 *
 * 所以這裡用真的檔案系統(tempdir)直接驗三條路徑,不啟動 Electron:
 *   1. 正常結束       → 報告回到原位、內容一致
 *   2. 被中斷(SIGKILL 等無法攔截的情況)→ **下一次執行**自我修復
 *   3. 報告與備份同時存在(被投毒的那一份)→ 修復時必須覆蓋掉它
 *
 * 執行:npx vitest run scripts/lib/__tests__/report-guard.test.mjs
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { recoverLeftoverBackup, restoreReport } from '../report-guard.mjs'

const REAL = JSON.stringify({ meta: { auditedStates: ['a', 'b'] }, problems: [] })
/** 被破壞的執行會寫出這種報告:狀態數一樣,但帶著不該存在的問題。 */
const POISONED = JSON.stringify({ meta: { auditedStates: ['a', 'b'] }, problems: [{ kind: 'fake' }] })

let dir
let report
let backup

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'report-guard-'))
  report = join(dir, 'report.json')
  backup = join(dir, 'report.selftest-backup.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('restoreReport', () => {
  it('正常結束:報告回到原位且內容一致', () => {
    writeFileSync(backup, REAL)
    expect(existsSync(report)).toBe(false)

    const r = restoreReport(report, backup, true)

    expect(r).toBe('restored')
    expect(existsSync(backup)).toBe(false)
    expect(readFileSync(report, 'utf8')).toBe(REAL)
  })

  it('本來就沒有報告時,被破壞執行產出的報告被清成 {} 而不是留著', () => {
    // hadReport=false:這一次執行開始前磁碟上沒有報告
    writeFileSync(report, POISONED)

    const r = restoreReport(report, backup, false)

    // 留一份被投毒的報告比沒有更糟 —— 它看起來跟真的沒有兩樣
    expect(r).toBe('empty-stamped')
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({})
  })

  it('沒有任何東西可還原時是 no-op(不是錯誤)', () => {
    expect(restoreReport(report, backup, true)).toBe('nothing-to-do')
    expect(existsSync(report)).toBe(false)
  })
})

describe('recoverLeftoverBackup(下一次執行的自我修復)', () => {
  it('被中斷的殘留(只有備份、沒有報告)會被還原', () => {
    // 這就是實測踩到的狀態:self-test 被逾時砍掉,留下備份而報告不見
    writeFileSync(backup, REAL)

    const recovered = recoverLeftoverBackup(report, backup)

    expect(recovered).toBe(true)
    expect(existsSync(backup)).toBe(false)
    expect(readFileSync(report, 'utf8')).toBe(REAL)
  })

  it('報告與備份同時存在時,覆蓋掉被投毒的那一份', () => {
    // 殘留 + 後來某次執行又產出了一份報告 = 磁碟上同時有兩份
    writeFileSync(backup, REAL)
    writeFileSync(report, POISONED)

    expect(recoverLeftoverBackup(report, backup)).toBe(true)

    // 關鍵:必須是**真的那份**,不是被投毒的那份
    // (renameSync 會覆蓋目標 —— 實測過 Windows 上也不會拋錯)
    expect(readFileSync(report, 'utf8')).toBe(REAL)
  })

  it('沒有殘留時回 false(不動任何檔案)', () => {
    writeFileSync(report, REAL)
    expect(recoverLeftoverBackup(report, backup)).toBe(false)
    expect(readFileSync(report, 'utf8')).toBe(REAL)
  })
})

describe('完整序列:自我修復 → 破壞 → 中斷 → 再修復', () => {
  it('連續兩次被中斷之後,報告仍然完好', () => {
    // 第一次:正常跑完 → 還原
    writeFileSync(backup, REAL)
    expect(restoreReport(report, backup, true)).toBe('restored')

    // 第二次:跑到一半被砍 → 只剩備份(這是實測踩到的狀態)
    renameSync(report, backup)
    expect(existsSync(report)).toBe(false)
    expect(existsSync(backup)).toBe(true)

    // 第三次執行開頭的自我修復把它撈回來
    expect(recoverLeftoverBackup(report, backup)).toBe(true)
    expect(readFileSync(report, 'utf8')).toBe(REAL)
  })
})
