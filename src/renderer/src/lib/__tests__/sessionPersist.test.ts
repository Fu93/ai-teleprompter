import { describe, it, expect, beforeEach } from 'vitest'
// fake-indexeddb 必須在 db.ts 被 import 之前掛上去(見 backup.test.ts 的說明)
import 'fake-indexeddb/auto'

import { createSessionPersister } from '../sessionPersist'
import { db } from '../db'
import type { TranscriptSegment } from '@shared/types'

function segs(n: number, textPrefix = '這是一段逐字稿內容'): TranscriptSegment[] {
  return Array.from({ length: n }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 8,
    text: `${textPrefix} ${i}`,
    speaker: i % 2 === 0 ? 'me' : 'them'
  }))
}

const base = { startedAt: 1_700_000_000_000, endedAt: 1_700_000_060_000 }

describe('createSessionPersister', () => {
  beforeEach(async () => {
    // 刻意不 db.close():關掉之後下一個 clear() 會撞 DatabaseClosedError,
    // 而那與這個檔要驗的行為無關(同 backup.test.ts 的理由)。
    await db.sessions.clear()
  })

  it('有段落時寫入一場會議,並帶上報告', async () => {
    const p = createSessionPersister()
    expect(await p.persist({ ...base, segments: segs(3) })).not.toBeNull()
    const rows = await db.sessions.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].segments).toHaveLength(3)
    expect(rows[0].report).toBeTruthy()
    expect(p.hasPersisted()).toBe(true)
  })

  it('回傳存進去的那一筆(含 Dexie 發的 id)—— 報告只算一次', async () => {
    const p = createSessionPersister()
    const saved = await p.persist({ ...base, segments: segs(3) })
    expect(saved).not.toBeNull()
    expect(saved?.id).toBeTypeOf('number')
    // 呼叫端(Record 頁的會後報告卡)重用的必須是**同一份計算結果**。
    // 用 toEqual 而不是 toBe:toArray() 讀回來的是 IndexedDB 的結構化複製,
    // 參考相等本來就不成立 —— 釘住的是內容相同,而不是同一個物件。
    expect(saved?.report).toEqual((await db.sessions.toArray())[0].report)
    expect(saved?.report).toBeTruthy()
  })

  it('沒有標題時用固定名稱,而非帶時間戳的標題', async () => {
    // 這一條原本斷言 `toMatch(/^會議 /)`,而舊實作是
    // `會議 ${formatDateTime(startedAt)}`。那正是第四輪 P1-2 的缺陷:清單列的
    // 標題下方又印一次 `{formatDateTime(s.startedAt)} · N 段`,所以每一場沒命名
    // 的會議都變成
    // `會議 2026/10/04 12:48 2026/10/04 12:48 · 1 段 · 未摘要`
    // —— 同一個時間戳印兩次,看起來像渲染壞掉。而「不命名」是多數人的預設路徑。
    //
    // 時間由清單列下方那一行負責,所以這裡只負責「沒有名字」這件事。
    const p = createSessionPersister()
    await p.persist({ ...base, segments: segs(1), title: '   ' })
    const rows = await db.sessions.toArray()
    expect(rows[0].title).toBe('未命名會議')
    // 關鍵不變量:標題裡不得再出現日期時間,否則又會與下方那行重複
    expect(rows[0].title).not.toMatch(/\d{4}\/\d{2}\/\d{2}/)
    expect(rows[0].title).not.toMatch(/\d{2}:\d{2}/)
  })

  it('自訂標題優先於自動生成', async () => {
    const p = createSessionPersister()
    await p.persist({ ...base, segments: segs(1), title: '客戶訪談' })
    expect((await db.sessions.toArray())[0].title).toBe('客戶訪談')
  })

  /**
   * 這是「只寫一次」的核心:兩條路徑(按停止 / 退出前存檔)可能同時成立。
   * 寫兩次的後果是使用者看到「我明明只開了一次會,為什麼有兩筆」——
   * 比少一筆更難向他解釋。
   */
  it('同一場不會被寫入兩次', async () => {
    const p = createSessionPersister()
    expect(await p.persist({ ...base, segments: segs(2) })).not.toBeNull()
    expect(await p.persist({ ...base, segments: segs(2) })).toBeNull()
    expect(await db.sessions.toArray()).toHaveLength(1)
  })

  /**
   * 反方向的那一半:守衛如果不會重置,第二場會議會因為第一場存過而被拒絕 ——
   * 那是更糟的靜默資料遺失,而且使用者完全不會知道自己少了一場。
   */
  it('reset 之後下一場可以正常寫入', async () => {
    const p = createSessionPersister()
    await p.persist({ ...base, segments: segs(2) })
    p.reset()
    expect(p.hasPersisted()).toBe(false)
    expect(await p.persist({ ...base, segments: segs(5) })).not.toBeNull()
    const rows = await db.sessions.toArray()
    expect(rows).toHaveLength(2)
    expect(rows[1].segments).toHaveLength(5)
  })

  it('沒有段落時不寫入(避免幽靈會議紀錄)', async () => {
    const p = createSessionPersister()
    expect(await p.persist({ ...base, segments: [] })).toBeNull()
    expect(await db.sessions.toArray()).toHaveLength(0)
    expect(p.hasPersisted()).toBe(false)
  })

  it('講完但一個字都沒辨識出來 → 仍然不寫', async () => {
    const p = createSessionPersister()
    expect(await p.persist({ ...base, segments: segs(0, 'x') })).toBeNull()
    expect(await db.sessions.toArray()).toHaveLength(0)
  })

  /**
   * 防Regression:抽出共用寫入函式時真的踩過。
   *
   * stop() 會在呼叫寫入器**之前**把 startedAt 的 ref 歸零。如果寫入器自己
   * 去讀那些 ref,它會讀到 0 → durationSec = 0 → 會後報告卡因為
   * `durationSec > 0` 不成立而整張不出現,症狀看起來像「報告不顯示」,
   * 和真正的病因(時間算錯)完全無關。
   *
   * 這裡釘住的是:startedAt 與 endedAt 決定 durationSec,兩者相等時為 0。
   * 呼叫端必須傳對 —— 這個測試讓那個錯誤在 sessionPersist 這一層就看得見。
   */
  it('startedAt 決定 durationSec —— 傳錯會讓整張報告卡消失', async () => {
    const p = createSessionPersister()
    const saved = await p.persist({ ...base, segments: segs(2) })
    expect(saved?.report?.durationSec).toBe(60)

    await db.sessions.clear()
    const p2 = createSessionPersister()
    // 模擬「refs 已被歸零」的情況:兩個時間點相同
    const zeroed = await p2.persist({
      segments: segs(2),
      startedAt: base.endedAt,
      endedAt: base.endedAt
    })
    expect(zeroed?.report?.durationSec).toBe(0)
  })

  it('報告是完整的一份(不是空物件),且帶入個人語速基準', async () => {
    const p = createSessionPersister()
    await p.persist({ ...base, segments: segs(4), personalCpm: 220 })
    const report = (await db.sessions.toArray())[0].report
    expect(report).toBeDefined()
    if (!report) throw new Error('報告不存在')
    // 退出前存檔與會後報告必須是同一份算法 —— 否則同一場會議會有兩種統計
    expect(report.durationSec).toBe(60)
    expect(report.myCpm).toBeGreaterThan(0)
    expect(report.generatedAt).toBeGreaterThan(0)
  })

  it('coachingCounts 有帶入就存,沒帶就不憑空造一個欄位', async () => {
    const p = createSessionPersister()
    await p.persist({ ...base, segments: segs(2), coachingCounts: { filler: 3 } })
    const report = (await db.sessions.toArray())[0].report
    expect(report?.coachingCounts).toEqual({ filler: 3 })

    await db.sessions.clear()
    const p2 = createSessionPersister()
    await p2.persist({ ...base, segments: segs(2) })
    expect((await db.sessions.toArray())[0].report?.coachingCounts).toBeUndefined()
  })
})
