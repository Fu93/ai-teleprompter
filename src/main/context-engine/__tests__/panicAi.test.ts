import { describe, it, expect } from 'vitest'
import { buildPanicPrompt, parseRescueResponse, computeConfidence, structuredFallback } from '../panicAi'

describe('buildPanicPrompt', () => {
  it('interview 與 meeting framing 不同', () => {
    const iv = buildPanicPrompt('interview', 'context here')
    const mt = buildPanicPrompt('meeting', 'context here')
    expect(iv).toContain('live job interview')
    expect(mt).toContain('live meeting or presentation')
    expect(iv).toContain('"sentence"')
    expect(iv).toContain('"points"')
    expect(iv).toContain('"confidence"')
  })

  it('context 截斷到 600 字', () => {
    const long = 'x'.repeat(2000)
    const prompt = buildPanicPrompt('meeting', long)
    expect(prompt).toContain('"""')
    // 截斷後不應包含完整 2000 字
    expect(prompt.length).toBeLessThan(2000)
  })
})

describe('parseRescueResponse(3 段式)', () => {
  it('第 1 段:直接 JSON', () => {
    const out = parseRescueResponse('{"sentence":"Say this.","points":"A / B","confidence":0.8}')
    expect(out?.sentence).toBe('Say this.')
    expect(out?.points).toBe('A / B')
    expect(out?.confidence).toBe(0.8)
  })

  it('第 2 段:混合文字中的 JSON 物件', () => {
    const noisy = 'Sure! Here is the rescue: {"sentence":"Bridge line.","points":"P1 / P2","confidence":0.5} hope it helps'
    const out = parseRescueResponse(noisy)
    expect(out?.sentence).toBe('Bridge line.')
    expect(out?.confidence).toBe(0.5)
  })

  it('第 3 段:純 regex 抽取(壞 JSON)', () => {
    const broken = '{"sentence":"Still works." "points":"X / Y" "confidence":0.42}' // 非法 JSON(缺逗號)
    const out = parseRescueResponse(broken)
    expect(out?.sentence).toBe('Still works.')
    expect(out?.points).toBe('X / Y')
    expect(out?.confidence).toBe(0.42)
  })

  it('完全無法解析回 null', () => {
    expect(parseRescueResponse('totally not json')).toBeNull()
    expect(parseRescueResponse('')).toBeNull()
  })
})

describe('computeConfidence', () => {
  it('模型有信心值時直接採用(clamp)', () => {
    expect(computeConfidence(0.9, 'ctx', 'ok sentence', 'pts')).toBe(0.9)
    expect(computeConfidence(2, 'ctx', 'ok sentence', 'pts')).toBe(1)
    expect(computeConfidence(-1, 'ctx', 'ok sentence', 'pts')).toBe(0)
  })

  it('無上下文扣分;句子長度合理加分', () => {
    const noCtx = computeConfidence(null, '(no recent speech detected)', 'a fine sentence', 'pts')
    const withCtx = computeConfidence(null, 'recent meeting talk', 'a fine sentence', 'pts')
    expect(noCtx).toBeLessThan(withCtx)
    expect(withCtx).toBeCloseTo(0.9, 5) // 0.6 + 0.2 + 0.1
  })

  it('過長句子不加長度分', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
    expect(computeConfidence(null, 'ctx', long, 'pts')).toBeCloseTo(0.8, 5)
  })
})

describe('structuredFallback', () => {
  it('兩種 mode 都有固定救援且 confidence 0.15', () => {
    expect(structuredFallback('interview').confidence).toBe(0.15)
    expect(structuredFallback('meeting').sentence).toContain('think')
    expect(structuredFallback('interview').source).toBe('template')
  })
})
