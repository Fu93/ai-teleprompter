import { describe, it, expect } from 'vitest'
import { TeleprompterEngine } from '../engine'
import type { ScriptModel } from '../scriptModel'

function makeModel(overrides: Partial<ScriptModel> = {}): ScriptModel {
  return {
    content: '',
    sentences: ['第一句', '第二句'],
    phrases: [
      [
        { text: '短語一', words: ['短', '語', '一'], type: 'normal' },
        { text: '短語二', words: ['短', '語', '二'], type: 'normal' }
      ],
      [{ text: '收尾短語', words: ['收', '尾', '短', '語'], type: 'normal' }]
    ],
    karaokeChunks: ['a b', 'c'],
    karaokeWordChunks: [['a', 'b'], ['c']],
    bullets: [
      { title: '要點一', subPoints: [] },
      { title: '要點二', subPoints: ['細節'] },
      { title: '要點三', subPoints: [] }
    ],
    ...overrides
  }
}

describe('phrase 模式', () => {
  it('依短語時長推進,句末帶停頓係數', () => {
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, maxTickDtMs: 60_000 },
      'phrase'
    )
    engine.play()
    const t0 = 1000
    expect(engine.tick(t0)).toBe('none') // 首幀僅初始化時鐘

    // 短語一:3 詞 → base 1500ms,非句末
    expect(engine.tick(t0 + 1499)).toBe('continuous')
    expect(engine.getState().phraseIndex).toBe(0)

    // 超過 1500ms → 前進到短語二(句末,3 詞 → base 1500 × 1.48 = 2220)
    expect(engine.tick(t0 + 1500)).toBe('discrete')
    expect(engine.getState().phraseIndex).toBe(1)
    expect(engine.getState().sentenceIndex).toBe(0)
    expect(engine.getState().stepDurationMs).toBeCloseTo(1500 * 1.48, 0)

    // 句末停留後 → 前進到第二句第一短語(4 詞 → 2000 × 1.48 = 2960)
    expect(engine.tick(t0 + 1500 + 2220)).toBe('discrete')
    expect(engine.getState().sentenceIndex).toBe(1)
    expect(engine.getState().phraseIndex).toBe(0)

    // 第二句只有一個短語(句末)→ 2960ms 後完成
    expect(engine.tick(t0 + 1500 + 2220 + 2960)).toBe('discrete')
    expect(engine.getState().status).toBe('completed')
  })

  it('速率倍率影響短語時長(下限 800ms 保護)', () => {
    const engine = new TeleprompterEngine(makeModel(), { rate: 2, scrollSpeed: 60 }, 'phrase')
    engine.play()
    // 3 詞 @rate2 → 750ms → 下限 800ms
    expect(engine.getState().stepDurationMs).toBe(800)
  })

  it('暫停時 tick 不推進,elapsed 不增加', () => {
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, maxTickDtMs: 60_000 },
      'phrase'
    )
    engine.play()
    engine.tick(1000)
    engine.pause()
    expect(engine.tick(2000)).toBe('none')
    const st = engine.getState()
    expect(st.elapsedMs).toBe(0)
    engine.play()
    engine.tick(2100) // 恢復播放後首幀重置時鐘
    engine.tick(2200)
    expect(engine.getState().elapsedMs).toBe(100)
  })

  it('預設防跳幀:單次 tick 的 dt 被夾在 250ms', () => {
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, totalH: 1000, wrapH: 200 },
      'scroll'
    )
    engine.play()
    engine.tick(0)
    engine.tick(1000) // dt 1000ms 被夾成 250ms → 60px/s × 0.25s = 15px
    expect(engine.getState().scrollPos).toBeCloseTo(15, 5)
  })
})

describe('karaoke 模式', () => {
  it('逐詞推進並跨 chunk,完成後標記 completed', () => {
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, maxTickDtMs: 60_000 },
      'karaoke'
    )
    engine.play()
    const t0 = 0
    engine.tick(t0)
    expect(engine.tick(t0 + 280)).toBe('discrete')
    expect(engine.getState().karaokeWordIndex).toBe(1)
    expect(engine.tick(t0 + 560)).toBe('discrete')
    expect(engine.getState().karaokeChunkIndex).toBe(1)
    expect(engine.getState().karaokeWordIndex).toBe(0)
    expect(engine.tick(t0 + 840)).toBe('discrete')
    expect(engine.getState().status).toBe('completed')
  })

  it('速率加倍時間減半', () => {
    const engine = new TeleprompterEngine(makeModel(), { rate: 2, scrollSpeed: 60 }, 'karaoke')
    engine.play()
    engine.tick(0)
    expect(engine.getState().stepDurationMs).toBe(140)
  })
})

describe('scroll 模式', () => {
  it('連續捲動直到邊界完成', () => {
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, totalH: 1000, wrapH: 200, maxTickDtMs: 60_000 },
      'scroll'
    )
    engine.play()
    engine.tick(0)
    expect(engine.tick(1000)).toBe('continuous')
    expect(engine.getState().scrollPos).toBeCloseTo(60, 5)

    // 60px/s × 14s = 840 = max → 完成
    expect(engine.tick(15000)).toBe('discrete')
    expect(engine.getState().status).toBe('completed')
    expect(engine.getState().scrollPos).toBe(840)
  })

  it('超出邊界的 scrollPos 被夾在最大值', () => {
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 600, totalH: 1000, wrapH: 200, maxTickDtMs: 60_000 },
      'scroll'
    )
    engine.play()
    engine.tick(0)
    engine.tick(5000) // 3000px 遠超 840
    expect(engine.getState().scrollPos).toBe(840)
    expect(engine.getState().status).toBe('completed')
  })

  it('尚未量測捲動容器時不完成也不推進(藥丸形態換稿的實測症狀)', () => {
    // 藥丸(收合)沒有捲動容器 → opts 缺 totalH/wrapH。舊行為:maxScroll 退化成
    // 40px,播放約 600ms 就被標成 completed,展開後也永遠回不來。
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, maxTickDtMs: 60_000 },
      'scroll'
    )
    engine.play()
    engine.tick(0)
    expect(engine.tick(30_000)).toBe('continuous')
    expect(engine.getState().status).toBe('playing')
    expect(engine.getState().scrollPos).toBe(0)
    // 時鐘照常累計:不是整段靜止,只是捲到哪無從得知
    expect(engine.getState().elapsedMs).toBeGreaterThan(0)
  })

  it('量測到容器後,播放中的捲動立刻接上', () => {
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, maxTickDtMs: 60_000 },
      'scroll'
    )
    engine.play()
    engine.tick(0)
    engine.tick(1000)
    expect(engine.getState().scrollPos).toBe(0)
    engine.setOptions({ totalH: 1000, wrapH: 200 })
    engine.tick(2000)
    expect(engine.getState().scrollPos).toBeCloseTo(60, 5)
    expect(engine.getState().status).toBe('playing')
  })
})

describe('bullet 模式(手動)', () => {
  it('play() 不啟動自動播放,tick 恆為 none', () => {
    const engine = new TeleprompterEngine(makeModel(), { rate: 1, scrollSpeed: 60 }, 'bullet')
    engine.play()
    expect(engine.getState().status).toBe('idle')
    expect(engine.tick(1000)).toBe('none')
  })

  it('manualNext / manualPrev 邊界正確', () => {
    const engine = new TeleprompterEngine(makeModel(), { rate: 1, scrollSpeed: 60 }, 'bullet')
    engine.manualNext()
    expect(engine.getState().bulletIndex).toBe(1)
    engine.manualNext()
    engine.manualNext() // 已在最後
    expect(engine.getState().bulletIndex).toBe(2)
    expect(engine.getState().status).toBe('completed')
    engine.manualPrev()
    expect(engine.getState().bulletIndex).toBe(1)
    expect(engine.getState().status).toBe('paused')
  })
})

describe('模式切換與重置', () => {
  it('切換模式重置游標、保留 elapsed;切到 bullet 時暫停', () => {
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, maxTickDtMs: 60_000 },
      'phrase'
    )
    engine.play()
    engine.tick(0)
    engine.tick(1600) // 已推進到短語二
    expect(engine.getState().phraseIndex).toBe(1)

    engine.setDisplayMode('karaoke')
    const st = engine.getState()
    expect(st.karaokeChunkIndex).toBe(0)
    expect(st.karaokeWordIndex).toBe(0)
    expect(st.elapsedMs).toBeGreaterThan(0)
    // 播放中切換模式:繼續播放(與 v3 行為一致)
    expect(st.status).toBe('playing')

    engine.setDisplayMode('bullet')
    // bullet 為手動模式,一律暫停自動播放
    expect(engine.getState().status).toBe('paused')
  })

  it('restart 重置所有游標並回到播放', () => {
    const engine = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, totalH: 1000, wrapH: 200 },
      'scroll'
    )
    engine.play()
    engine.tick(0)
    engine.tick(2000)
    engine.restart()
    const st = engine.getState()
    expect(st.scrollPos).toBe(0)
    expect(st.elapsedMs).toBe(0)
    expect(st.status).toBe('playing')
  })
})

describe('查詢介面', () => {
  it('getRemainingMs:phrase 模式等於剩餘短語時長總和', () => {
    const engine = new TeleprompterEngine(makeModel(), { rate: 1, scrollSpeed: 60 }, 'phrase')
    // 未播放時:短語一 1500(非句末)+ 短語二 1500×1.48(句末)+ 句二 2000×1.48(句末)
    expect(engine.getRemainingMs()).toBe(1500 + 1500 * 1.48 + 2000 * 1.48)
  })

  it('getRemainingMs:scroll 模式依速度換算;bullet 為 null', () => {
    const scroll = new TeleprompterEngine(
      makeModel(),
      { rate: 1, scrollSpeed: 60, totalH: 1000, wrapH: 200 },
      'scroll'
    )
    expect(scroll.getRemainingMs()).toBe((840 / 60) * 1000)

    const bullet = new TeleprompterEngine(makeModel(), { rate: 1, scrollSpeed: 60 }, 'bullet')
    expect(bullet.getRemainingMs()).toBeNull()
  })

  it('progress 介於 0 與 1', () => {
    const engine = new TeleprompterEngine(makeModel(), { rate: 1, scrollSpeed: 60 }, 'phrase')
    expect(engine.progress).toBeGreaterThanOrEqual(0)
    expect(engine.progress).toBeLessThanOrEqual(1)
  })
})
