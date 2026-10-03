/**
 * backup.test.ts — 資料備份的往返與防護。
 *
 * 為什麼核心是「往返」而不是各個小函式:
 *   備份的價值只有一個判準 —— 「匯出再還原之後,使用者的東西有沒有回來」。
 *   每一個函式單獨測都綠但資料回不來,是這類功能最常見的失敗方式。
 *   所以這裡做的是真的:寫進去、倒出來、清空、寫回去、逐筆比對。
 *
 * 跑在 Node 上(沒有 jsdom):Dexie 在 Node 需要 fake-indexeddb,
 * 而這條測試刻意避開 DOM —— 備份的本質是資料往返,不是畫面。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

// fake-indexeddb 必須在 db.ts 被 import 之前掛上去
import 'fake-indexeddb/auto'

import { db } from '../db'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupError,
  backupFileName,
  buildBackup,
  currentCounts,
  importBackup,
  parseBackup,
  serializeBackup,
  stripSecrets
} from '../backup'
import type { MeetingSession, PracticeRun, Script } from '@shared/types'

const SCRIPT: Script = {
  id: 1,
  title: '季度簡報',
  content: '第一段\n\n第二段',
  tags: ['工作'],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  lastUsedAt: 1_700_000_200_000
}
const SESSION: MeetingSession = {
  id: 7,
  title: '產品會議',
  startedAt: 1_700_001_000_000,
  endedAt: 1_700_003_600_000,
  segments: [
    { speaker: 'them', text: '歡迎大家', start: 0, end: 2 },
    { speaker: 'me', text: '我先報告進度', start: 2, end: 6 }
  ],
  summary: {
    abstract: '摘要',
    keyPoints: ['重點一'],
    todos: ['待辦一'],
    followUps: ['追蹤一'],
    generatedAt: 1_700_003_000_000,
    model: 'qwen2.5:7b'
  }
}
const RUN: PracticeRun = {
  id: 3,
  position: '後端工程師',
  type: '技術面試',
  questions: ['請自我介紹'],
  answers: [{ question: '請自我介紹', answerTranscript: '我做後端十年', durationSec: 12 }],
  createdAt: 1_700_002_000_000,
  overallFeedback: '回答太短'
}

async function clearAll(): Promise<void> {
  await Promise.all([db.scripts.clear(), db.sessions.clear(), db.practiceRuns.clear()])
}

describe('backup', () => {
  beforeEach(async () => {
    await clearAll()
  })
  afterEach(async () => {
    // 刻意不 db.close():關掉之後下一個測試的 clearAll() 會撞上
    // DatabaseClosedError,而那與本檔要驗的行為無關。fake-indexeddb 是
    // 進程內的,清空就足以讓每條測試從空資料開始。
    await clearAll()
  })

  it('往返:匯出 → 清空 → 還原,三個 store 逐筆回來', async () => {
    await db.scripts.add(SCRIPT)
    await db.sessions.add(SESSION)
    await db.practiceRuns.add(RUN)

    const backup = await buildBackup({ appVersion: '0.2.0', settings: { personal: { fontSize: 24 } } })
    expect(backup.counts).toEqual({ scripts: 1, sessions: 1, practiceRuns: 1 })

    // 真的走一次序列化:parseBackup 拿到的是字串解析後的結果,而 JSON.stringify
    // 會丟掉 undefined 欄位 —— 那正是最容易讓往返壞掉的地方。
    const text = serializeBackup(backup)
    const parsed = parseBackup(text)

    await clearAll()
    expect(await currentCounts()).toEqual({ scripts: 0, sessions: 0, practiceRuns: 0 })

    const res = await importBackup(parsed)
    expect(res.counts).toEqual({ scripts: 1, sessions: 1, practiceRuns: 1 })

    const scripts = await db.scripts.toArray()
    const sessions = await db.sessions.toArray()
    const runs = await db.practiceRuns.toArray()

    // 逐筆比對內容。id 刻意不比:還原時丟掉舊 id 讓 Dexie 重新發號,
    // 比對時把 id 拿掉,否則這條測試會把「重新發號」誤判成資料遺失。
    const withoutId = (r: { id?: number }): Omit<{ id?: number }, 'id'> => {
      const { id: _id, ...rest } = r
      return rest
    }
    expect(scripts.map(withoutId)).toEqual([withoutId(SCRIPT)])
    expect(sessions.map(withoutId)).toEqual([withoutId(SESSION)])
    expect(runs.map(withoutId)).toEqual([withoutId(RUN)])
  })

  it('往返後設定也跟著回來(個人化校準與浮層設定是使用者調出來的)', async () => {
    const settings = { personal: { fontSize: 31, charsPerMin: 180 }, overlay: { pillScale: 1.25 } }
    const backup = await buildBackup({ appVersion: '0.2.0', settings })
    expect(backup.settings).toEqual(settings)
  })

  it('還原是取代:不在備份裡的舊資料會真的消失', async () => {
    // 備份必須在「舊資料」存在**之前**就做好。先加東西再 buildBackup,
    // 會把那筆一起讀進去 —— 這個順序錯誤讓本測試一開始測不到取代語意。
    const backup = await buildBackup({ appVersion: '0.2.0', settings: {} })
    expect(backup.counts).toEqual({ scripts: 0, sessions: 0, practiceRuns: 0 })

    await db.scripts.add({ ...SCRIPT, id: undefined, title: '舊的、會被取代' })
    await db.sessions.add({ ...SESSION, id: undefined, title: '這場也要消失' })
    expect((await currentCounts()).scripts).toBe(1)

    await importBackup(parseBackup(serializeBackup(backup)))
    // 空的備份必須真的把資料清掉,而不是「沒東西可寫所以什麼都不做」
    expect(await currentCounts()).toEqual({ scripts: 0, sessions: 0, practiceRuns: 0 })
  })

  it('還原時丟掉舊 id,避免撞上自增鍵', async () => {
    await db.scripts.add(SCRIPT)
    const backup = await buildBackup({ appVersion: '0.2.0', settings: {} })
    await clearAll()
    await importBackup(backup)
    const back = await db.scripts.toArray()
    // 不是「必須等於 1」,而是「不能帶著舊 id 1 回來」
    expect(back).toHaveLength(1)
    expect(back[0].title).toBe('季度簡報')
  })

  describe('金鑰永遠不離開這台電腦', () => {
    it('剝除頂層的 apiKey / sttApiKey', () => {
      const out = stripSecrets({ ai: { apiKey: 'sk-real-key' }, stt: { sttApiKey: 'sk-stt' } })
      expect(out).toEqual({ ai: { apiKey: '' }, stt: { sttApiKey: '' } })
    })

    it('剝除陣列裡的物件(場景包這種結構)', () => {
      const out = stripSecrets([{ token: 'a' }, { token: 'b' }])
      expect(out).toEqual([{ token: '' }, { token: '' }])
    })

    it('大小寫變體也擋 —— 欄位名比對不是大小寫敏感等於沒擋', () => {
      const out = stripSecrets({ apikey: 'x', APIKEY: 'y', Secret: 'z', password: 'p', Authorization: 'a' })
      expect(out).toEqual({ apikey: '', APIKEY: '', Secret: '', password: '', Authorization: '' })
    })

    it('沒有深度的限制:再巢狀兩層也剝得到', () => {
      const out = stripSecrets({ a: { b: { c: { apiKey: 'deep' } } } })
      expect(out).toEqual({ a: { b: { c: { apiKey: '' } } } })
    })

    it('不誤傷看起來像字串的正常設定', () => {
      const out = stripSecrets({ personal: { fontSize: 24 }, hotkeys: { toggleOverlay: 'Ctrl+Alt+T' } })
      expect(out).toEqual({ personal: { fontSize: 24 }, hotkeys: { toggleOverlay: 'Ctrl+Alt+T' } })
    })

    it('整份備份裡不含金鑰(這是使用者會看到的承諾)', async () => {
      const backup = await buildBackup({
        appVersion: '0.2.0',
        settings: { ai: { openaiCompatible: { apiKey: 'sk-真的金鑰' } } }
      })
      expect(serializeBackup(backup)).not.toContain('sk-真的金鑰')
    })
  })

  describe('格式不符要給人話錯誤,不吞掉', () => {
    it('不是 JSON', () => {
      expect(() => parseBackup('這不是 json')).toThrow(BackupError)
      expect(() => parseBackup('這不是 json')).toThrow(/不是一個 JSON 檔/)
    })

    it('是 JSON 但不是備份檔', () => {
      expect(() => parseBackup('{"hello":"world"}')).toThrow(/不是 AI 提詞機的備份檔/)
    })

    it('版本比 App 新 —— 說清楚是「先更新 App」而不是「檔案壞了」', () => {
      const future = JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION + 1,
        appVersion: '9.9.9',
        exportedAt: new Date().toISOString(),
        counts: { scripts: 0, sessions: 0, practiceRuns: 0 },
        data: { scripts: [], sessions: [], practiceRuns: [] },
        settings: {}
      })
      expect(() => parseBackup(future)).toThrow(/請先更新 App/)
    })

    it('data 缺欄位', () => {
      const broken = JSON.stringify({ format: BACKUP_FORMAT, version: 1, data: { scripts: [] } })
      expect(() => parseBackup(broken)).toThrow(/缺少資料內容/)
    })

    it('錯誤訊息是中文句子,不是 error code', () => {
      let msg = ''
      try {
        parseBackup('{}')
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toContain('AI 提詞機')
    })
  })

  describe('檔名', () => {
    it('帶時間戳,而且是合法的檔名', () => {
      const name = backupFileName(new Date(2026, 8, 30, 14, 32))
      expect(name).toBe('ai-teleprompter-backup-20260930-1432.json')
      expect(name).not.toMatch(/[\\/:*?"<>|]/)
    })
  })

  describe('savedAsScriptId 在還原後仍然指向同一份講稿', () => {
    // 注意:還原會重新發號,所以下面都用「還原後查出來的那筆」,不能用還原前的 key。
    const roundTrip = async (): Promise<MeetingSession> => {
      const backup = parseBackup(
        serializeBackup(await buildBackup({ appVersion: '0.2.0', settings: {} }))
      )
      await clearAll()
      await importBackup(backup)
      const restored = await db.sessions.toCollection().first()
      if (!restored) throw new Error('還原後應該要有一場會議')
      return restored
    }

    it('id 序列有缺口(使用者刪過講稿)也不會指向別人的稿', async () => {
      await db.scripts.add({ title: 'A', content: 'a', createdAt: 1, updatedAt: 1 })
      await db.scripts.add({ title: 'B', content: 'b', createdAt: 2, updatedAt: 2 })
      const target = (await db.scripts.add({
        title: 'C',
        content: 'c',
        createdAt: 3,
        updatedAt: 3
      })) as number
      await db.scripts.delete(2) // 缺口:舊 id 不連續,重新發號後整批位移
      await db.sessions.add({ ...SESSION, savedAsScriptId: target })

      const restored = await roundTrip()
      // 沒做對照表的話,這個 id 會指向另一份稿或一個不存在的 id
      const ref =
        restored.savedAsScriptId != null ? await db.scripts.get(restored.savedAsScriptId) : undefined
      expect(ref?.title).toBe('C')
    })

    it('備份裡根本沒有那份講稿時,參照清掉(寧可讓按鈕恢復可按)', async () => {
      await db.sessions.add({ ...SESSION, savedAsScriptId: 3 })
      const restored = await roundTrip()
      expect(restored.savedAsScriptId).toBeUndefined()
    })

    it('本來就沒存成講稿的會議不受影響', async () => {
      await db.sessions.add({ ...SESSION })
      const restored = await roundTrip()
      expect(restored.savedAsScriptId).toBeUndefined()
    })
  })
})
