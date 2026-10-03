import { describe, it, expect } from 'vitest'
import { degrade, formatClock, formatDuration, formatTransport, normalizeScriptTitle } from '../utils'

describe('formatClock', () => {
  /** 固定時區才能斷言 —— 否則這條測試在 CI 的 TZ 與本機不同時會紅 */
  const at = (h: number, m: number): number => new Date(2026, 9, 3, h, m, 0, 0).getTime()

  it('只印時分,捨去秒', () => {
    expect(formatClock(at(14, 32))).toBe('14:32')
  })

  it('小於十點要補零,否則按鈕寬度會在每次存檔時跳動', () => {
    expect(formatClock(at(9, 5))).toBe('09:05')
    expect(formatClock(at(0, 0))).toBe('00:00')
  })

  it('午夜前後不會變成 24:xx', () => {
    expect(formatClock(at(23, 59))).toBe('23:59')
  })
})

/** 回歸:藥丸「下一個關鍵詞」從句中切字,曾顯示「，今天想跟」以逗號開頭 */
describe('degrade(漸進揭露)', () => {
  it('剝掉前導標點:從句中切出的關鍵詞不以標點開頭', () => {
    expect(degrade('，今天想跟大家分享三個重點', 4)).toBe('今天想跟')
    expect(degrade('。下一句是什麼', 3)).toBe('下一句')
  })

  it('切後結果若以標點開頭(切點落在標點),再剝一次', () => {
    // 「嗯，今天」→ trim 後切 2 = 「嗯，」?不:degrade 先剝前導再切;
    // 直接驗證不變量:結果永不以標點/空白開頭
    for (const input of ['，今天想跟大家說', '、其次是', '：結論如下', ' 嗯，好']) {
      expect(degrade(input, 3)).not.toMatch(/^[，。、；：！？．,\\.:;!?\\s]/)
    }
  })

  it('不影響正常輸入與原有行為', () => {
    expect(degrade('今天想跟大家分享', 4)).toBe('今天想跟')
    expect(degrade('短詞', 6)).toBe('短詞')
  })
})

/**
 * 回歸:浮層時間列曾經顯示 `0:00 / -0:00`(播完/空稿)。
 *
 * 這一組測試的目的是把「時間軸上不得出現負值」變成機器檢查 —— 原本那一行
 * 是寫在 JSX 裡的字串拼接(` / -${formatDuration(...)}`),六支 UI 稽核全綠
 * 也攔不住它,因為 `-0:00` 是一個完全合法的字串。
 */
describe('formatTransport(浮層時間列)', () => {
  it('正常播放時同時給出已播與剩餘', () => {
    expect(formatTransport(192, 108_000)).toBe('已播 3:12 · 剩 1:48')
  })

  it('播畢時顯示「已播畢」而不是「剩 0:00」', () => {
    expect(formatTransport(300, 0)).toBe('已播 5:00 · 已播畢')
  })

  it('剩餘不到一秒也算播畢(邊界不得漏出 0:00)', () => {
    expect(formatTransport(300, 400)).toBe('已播 5:00 · 已播畢')
  })

  it('bullet 模式沒有剩餘時間(remainingMs = null)時只顯示已播', () => {
    expect(formatTransport(65, null)).toBe('已播 1:05')
  })

  it('任何輸入都不得產生帶負號的時間', () => {
    // 這條是不變量,不是案例:負的剩餘若真的從引擎漏出來(例如之後改了
    // getRemainingMs 的 clamp),格式層要守住最後一道。
    for (const [elapsed, remaining] of [
      [0, 0],
      [0, -1],
      [0, Number.NEGATIVE_INFINITY],
      [-30, -5000],
      [12, Number.NaN]
    ] as Array<[number, number]>) {
      const out = formatTransport(elapsed, remaining)
      expect(out).not.toMatch(/-\d/)
      // NaN/Infinity 不得漏到畫面上:`剩 NaN:NaN` 比不顯示更糟。
      expect(out).not.toMatch(/NaN|Infinity/)
      expect(out).toContain('已播')
    }
  })

  it('formatDuration 的斗零本身就是 0:00(所以負號只可能來自手寫字串)', () => {
    expect(formatDuration(-1)).toBe('0:00')
    expect(formatDuration(0)).toBe('0:00')
  })
})

/**
 * 回歸:空白標題存檔後清單寫「未命名講稿」,浮層卻顯示 fallback「提詞浮層」——
 * 同一份稿子兩個名字。normalizeScriptTitle 是存檔與浮層 payload 的共同出處。
 */
describe('normalizeScriptTitle(標題正規化的單一出處)', () => {
  it('trim 後空 → 未命名講稿(存檔與浮層必須同名)', () => {
    expect(normalizeScriptTitle('')).toBe('未命名講稿')
    expect(normalizeScriptTitle('   ')).toBe('未命名講稿')
    expect(normalizeScriptTitle(' \t\n ')).toBe('未命名講稿')
  })

  it('非空標題只去首尾空白,中間原樣', () => {
    expect(normalizeScriptTitle(' 週會 紀錄 ')).toBe('週會 紀錄')
    expect(normalizeScriptTitle('未命名講稿')).toBe('未命名講稿')
  })
})
