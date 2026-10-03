/**
 * sessionToScript.test.ts — 「逐字稿 → 講稿」的資料層與防重複。
 *
 * 核心是**冪等**:同一場會議第二次呼叫不得再建一份講稿。
 * 原本的防重複只活在 Record 頁的 component state(Set<number>),切頁/重啟
 * 就歸零 —— 使用者回來再按一次就有兩份一模一樣的講稿。現在事實存在
 * MeetingSession.savedAsScriptId,這裡驗的就是那個事實真的被寫下、被讀回。
 *
 * 負向驗證:拿掉 saveSessionAsScript 開頭的 savedAsScriptId 檢查,
 * 「重複呼叫冪等」那條測試當場變紅(講稿數 1 → 2)。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'

// fake-indexeddb 必須在 db.ts 被 import 之前掛上去(與 backup.test.ts 同一模式)
import 'fake-indexeddb/auto'

import { db } from '../db'
import {
  saveSessionAsScript,
  transcriptToScriptBody,
  isSessionSavedAsScript,
  unlinkScriptFromSessions
} from '../sessionToScript'
import type { MeetingSession } from '@shared/types'

function session(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    title: '週會',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_600_000,
    segments: [
      { speaker: 'me', text: '我先講結論', start: 0, end: 4 },
      { speaker: 'them', text: '好,請說', start: 5, end: 7 },
      { speaker: 'me', text: '第一點是進度', start: 8, end: 12 }
    ],
    ...overrides
  }
}

beforeEach(async () => {
  await db.scripts.clear()
  await db.sessions.clear()
})
afterEach(async () => {
  await db.scripts.clear()
  await db.sessions.clear()
})

describe('transcriptToScriptBody', () => {
  it('只取我方發言,段落前保留時間戳(提詞是給自己講的)', () => {
    const body = transcriptToScriptBody(session())
    expect(body).toContain('我先講結論')
    expect(body).toContain('第一點是進度')
    expect(body).not.toContain('好,請說')
    expect(body.split('\n').every((line) => /^\[\d+:\d\d\] /.test(line))).toBe(true)
  })

  it('沒有我方段落時退回全部(單人錄音也有救)', () => {
    const body = transcriptToScriptBody(
      session({ segments: [{ speaker: 'them', text: '只有對方', start: 0, end: 2 }] })
    )
    expect(body).toContain('只有對方')
  })
})

describe('saveSessionAsScript', () => {
  it('建立講稿並把 savedAsScriptId 寫回 session(「存過了」是事實,不是記憶)', async () => {
    const s = session()
    s.id = await db.sessions.add(s)
    const res = await saveSessionAsScript(s)
    expect(res).toEqual({ ok: true, scriptId: expect.any(Number), created: true })
    const scriptId = (res as { scriptId: number }).scriptId
    const stored = await db.sessions.get(s.id!)
    expect(stored?.savedAsScriptId).toBe(scriptId)
    const script = await db.scripts.get(scriptId)
    expect(script?.title).toBe('週會（講稿）')
  })

  it('重複呼叫冪等:不再建第二份講稿(跨頁/重啟的防重複靠這條)', async () => {
    const s = session()
    s.id = await db.sessions.add(s)
    const first = await saveSessionAsScript(s)
    // 模擬「切頁再回來」:從 DB 重讀 session(畫面 Set 已歸零)
    const reloaded = await db.sessions.get(s.id!)
    const second = await saveSessionAsScript(reloaded!)
    expect(second).toEqual({ ok: true, scriptId: (first as { scriptId: number }).scriptId, created: false })
    expect(await db.scripts.count()).toBe(1)
  })

  it('空逐字稿不建檔,回報 empty(呼叫端給人話訊息)', async () => {
    const s = session({ segments: [] })
    s.id = await db.sessions.add(s)
    expect(await saveSessionAsScript(s)).toEqual({ ok: false, reason: 'empty' })
    expect(await db.scripts.count()).toBe(0)
  })

  it('沒有 id 的 session(未落盤)仍可建稿,只是不寫回指標', async () => {
    const res = await saveSessionAsScript(session())
    expect(res).toEqual({ ok: true, scriptId: expect.any(Number), created: true })
  })
})

describe('isSessionSavedAsScript(參照必須指向一份還在的講稿)', () => {
  const known = new Set([7])

  it('參照指向的講稿還在 → 已存成', () => {
    expect(isSessionSavedAsScript(session({ savedAsScriptId: 7 }), known)).toBe(true)
  })

  it('參照指向的講稿已被刪掉 → 不算已存(按鈕必須恢復可按)', () => {
    // 這是「講稿刪掉後那場會議永遠卡在 disabled 的『已存成講稿』」那條死路
    expect(isSessionSavedAsScript(session({ savedAsScriptId: 99 }), known)).toBe(false)
  })

  it('還沒問過資料庫(null)→ 保守當成已存(寧可不可按,也不要按兩次生出兩份稿)', () => {
    expect(isSessionSavedAsScript(session({ savedAsScriptId: 99 }), null)).toBe(true)
  })

  it('這一頁剛存過的 session 以畫面 Set 為準(按鈕要立即反映剛做的動作)', () => {
    const s = session({ savedAsScriptId: undefined })
    s.id = 42
    expect(isSessionSavedAsScript(s, known, new Set([42]))).toBe(true)
    expect(isSessionSavedAsScript(s, known, new Set([41]))).toBe(false)
  })
})

describe('unlinkScriptFromSessions(講稿被刪時,參照要跟著失效)', () => {
  it('清掉所有指向它的 session,回傳受影響筆數', async () => {
    const a = session()
    a.id = await db.sessions.add(a)
    const b = session()
    b.id = await db.sessions.add(b)
    const other = session()
    other.id = await db.sessions.add(other)
    const scriptA = await db.scripts.add({ title: 'A', content: 'a', createdAt: 1, updatedAt: 1 })
    const scriptB = await db.scripts.add({ title: 'B', content: 'b', createdAt: 2, updatedAt: 2 })
    // update 的第一個參數要給主鍵。給整個物件不會報錯,也不會寫入 ——
    // 寫測試時踩過一次,所以這裡三筆都傳 a.id / b.id。
    await db.sessions.update(a.id!, { savedAsScriptId: scriptA as number })
    await db.sessions.update(b.id!, { savedAsScriptId: scriptA as number })
    await db.sessions.update(other.id!, { savedAsScriptId: scriptB as number })

    const touched = await unlinkScriptFromSessions(scriptA as number)
    expect(touched).toBe(2)
    // 留著參照會讓 Record 頁的按鈕永遠是 disabled 的「已存成講稿」
    expect((await db.sessions.get(a.id!))?.savedAsScriptId).toBeUndefined()
    expect((await db.sessions.get(b.id!))?.savedAsScriptId).toBeUndefined()
    // 別場會議指向別的講稿,不能被連帶清掉
    expect((await db.sessions.get(other.id!))?.savedAsScriptId).toBe(scriptB)
  })
})
