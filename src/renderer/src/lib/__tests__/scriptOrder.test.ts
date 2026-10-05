/**
 * scriptOrder.test.ts — 講稿清單排序規則的釘住。
 *
 * 為什麼值得測:這個排序處理的是「可選欄位的缺失」(lastUsedAt 可能不存在)。
 * 那正是最容易在改動時無聲退化的地方 —— 把 `undefined` 當 0 排**看起來**
 * 也對,於是沒有人發現規則已經換掉了。
 */
import { describe, expect, it } from 'vitest'
import { formatLastUsed, sortScripts } from '../scriptOrder'
import type { OrderableScript } from '../scriptOrder'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 標題只是為了讓失敗訊息看得出是哪一筆 */
const S = (title: string, updatedAt: number, lastUsedAt?: number): OrderableScript & { title: string } => ({
  title,
  updatedAt,
  ...(lastUsedAt === undefined ? {} : { lastUsedAt })
})

const titles = (list: { title: string }[]): string[] => list.map((s) => s.title)

describe('sortScripts — edited(預設,維持原本行為)', () => {
  it('依 updatedAt 由新到舊', () => {
    const list = [S('舊', 100), S('新', 300), S('中', 200)]
    expect(titles(sortScripts(list, 'edited'))).toEqual(['新', '中', '舊'])
  })

  it('與「先寫的稿子在後面」一致 —— 對應原本的 orderBy(updatedAt).reverse()', () => {
    // 這一條是刻意的:切換排序不該順便改掉預設順序,否則使用者第一次開啟
    // 清單時會看到與上一版不同的排列,而且沒有人能解釋為什麼。
    const list = [S('a', 1000), S('b', 3000), S('c', 2000)]
    expect(titles(sortScripts(list, 'edited'))).toEqual(['b', 'c', 'a'])
  })

  it('updatedAt 相同時保持輸入順序(穩定排序)', () => {
    const list = [S('x', 100), S('y', 100), S('z', 100)]
    expect(titles(sortScripts(list, 'edited'))).toEqual(['x', 'y', 'z'])
  })
})

describe('sortScripts — used(最近使用)', () => {
  it('依 lastUsedAt 由新到舊', () => {
    const list = [
      S('早上講的', 9000, 1000),
      S('剛剛講的', 100, 9000),
      S('下午講的', 5000, 5000)
    ]
    expect(titles(sortScripts(list, 'used'))).toEqual(['剛剛講的', '下午講的', '早上講的'])
  })

  /**
   * 這一條是**整個功能的核心**,而它對應的真實情境是:
   * 「我上週改過但上個月講過的稿」不該排在「我上個月改過但剛剛講過的稿」前面。
   * 只按 updatedAt 排就會犯這個錯 —— 而那正是使用者回到這個 App 的理由。
   */
  it('剛剛用過但很久沒編輯的稿,排在剛剛編輯但很久沒用過的稿前面', () => {
    const list = [
      S('上週改過、上個月講過', 9_000, 1_000),
      S('上個月改過、剛剛講過', 1_000, 9_000)
    ]
    expect(titles(sortScripts(list, 'used'))).toEqual(['上個月改過、剛剛講過', '上週改過、上個月講過'])
    // 反向對照:同一份資料在「最近編輯」下是相反的答案 —— 這證明排序真的有作用,
    // 而不是在兩種模式下碰巧回傳同一個陣列參考。
    expect(titles(sortScripts(list, 'edited'))).toEqual(['上週改過、上個月講過', '上個月改過、剛剛講過'])
  })

  it('從沒用過的稿全部排在最後(而不是混在中間)', () => {
    const list = [
      S('沒用過-最新', 9_000),
      S('用過的', 100, 5_000),
      S('沒用過-最舊', 200)
    ]
    expect(titles(sortScripts(list, 'used'))).toEqual(['用過的', '沒用過-最新', '沒用過-最舊'])
  })

  it('全都沒用過時,退化成依 updatedAt 由新到舊', () => {
    // 邊界:清單裡一份都沒用過時,這個排序不能變成「全部同分、順序隨便」。
    const list = [S('a', 100), S('b', 300), S('c', 200)]
    expect(titles(sortScripts(list, 'used'))).toEqual(['b', 'c', 'a'])
  })

  it('lastUsedAt 為 undefined 與「不存在這個鍵」視為相同', () => {
    // 從 Dexie 讀回來的物件可能根本沒有這個鍵,也可能值是 undefined。
    // 兩者都必須落在「沒用過」,否則 undefined 會被 sort 當成 NaN 比較而靜默不動。
    const list = [{ title: '缺鍵', updatedAt: 9000 }, S('明確 undefined', 8000, undefined), S('用過', 1, 5_000)]
    expect(titles(sortScripts(list, 'used'))).toEqual(['用過', '缺鍵', '明確 undefined'])
  })

  /**
   * 這一條是 `lastUsedAt ?? 0` 那個版本**擋不住**的場景,而它值得單獨一條。
   *
   * 直覺的寫法(`(b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)`)在「至少有一份用過」時
   * 會給出**與正確答案完全相同**的結果 —— 所以它能通過上面每一條測試,
   * 卻在「全都沒用過」時退化成一堆 0 之間的穩定序,也就是**輸入順序**。
   *
   * 換句話說:那個版本的正確性取決於呼叫端剛好傳進來是什麼順序。
   * 而 db 查詢的順序是會被別人改掉的(換索引、加 where、換排序鍵),
   * 到時候這個排序會無聲地變成「隨機」—— 沒有測試會紅。
   *
   * 所以這條斷言的是**與輸入順序無關**:同一組資料,打亂輸入,輸出必須一樣。
   */
  it('輸出與輸入順序無關(打亂輸入不該改變結果)', () => {
    const a = S('沒用過-舊', 200)
    const b = S('用過的', 100, 5_000)
    const c = S('沒用過-新', 9_000)
    const forward = titles(sortScripts([a, b, c], 'used'))
    const shuffled = titles(sortScripts([c, a, b], 'used'))
    const reversed = titles(sortScripts([b, c, a], 'used'))
    expect(forward).toEqual(['用過的', '沒用過-新', '沒用過-舊'])
    expect(shuffled).toEqual(forward)
    expect(reversed).toEqual(forward)
  })
  it('不修改輸入陣列(React state 被就地改掉會讓重新渲染失效)', () => {
    const list = [S('a', 100), S('b', 300)]
    const snapshot = titles(list)
    const sorted = sortScripts(list, 'used')
    expect(sorted).not.toBe(list)
    expect(titles(list)).toEqual(snapshot)
  })

  it('空陣列與單一元素不會出錯', () => {
    expect(sortScripts([], 'used')).toEqual([])
    expect(sortScripts([S('only', 1)], 'used')).toHaveLength(1)
  })
})

describe('formatLastUsed', () => {
  const now = 1_000 * DAY

  it('從沒用過回 null —— 呼叫端應該完全不顯示,不是顯示「從未使用」', () => {
    expect(formatLastUsed(undefined, now)).toBeNull()
  })

  it('一分鐘內是「剛剛」', () => {
    expect(formatLastUsed(now, now)).toBe('剛剛')
    expect(formatLastUsed(now - 59_000, now)).toBe('剛剛')
  })

  it('剛好滿一分鐘變成「1 分鐘前」(邊界要從分鐘開始算,不是還沒滿就顯示)', () => {
    expect(formatLastUsed(now - MIN, now)).toBe('1 分鐘前')
    expect(formatLastUsed(now - 59 * MIN, now)).toBe('59 分鐘前')
  })

  it('滿一小時變成「N 小時前」', () => {
    expect(formatLastUsed(now - HOUR, now)).toBe('1 小時前')
    expect(formatLastUsed(now - 23 * HOUR, now)).toBe('23 小時前')
  })

  it('滿一天變成「N 天前」', () => {
    expect(formatLastUsed(now - DAY, now)).toBe('1 天前')
    expect(formatLastUsed(now - 6 * DAY, now)).toBe('6 天前')
  })

  it('超過一週改用絕對日期(相對時間在這裡要心算,而且會撐寬欄位)', () => {
    const s = formatLastUsed(now - 30 * DAY, now)
    expect(s).toMatch(/^\d{4}\/\d{2}\/\d{2}$/)
    expect(s).not.toContain('天前')
  })

  it('時鐘被調到未來時不顯示「-3 分鐘」', () => {
    // 使用者改系統時間(或跨時區)就會遇到。顯示一個負的相對時間會讓他
    // 覺得資料壞了,而實際上只是時間順序反了。
    expect(formatLastUsed(now + 5 * MIN, now)).toBe('剛剛')
  })

  it('0 是有效時間戳,不會被當成「沒有值」', () => {
    // 這是 `!= null` 而不是 `!` 的原因:0 是合法的 epoch。
    expect(formatLastUsed(0, now)).not.toBeNull()
  })
})
