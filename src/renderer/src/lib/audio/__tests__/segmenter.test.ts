import { describe, expect, it, vi } from 'vitest'
import { AudioSegmenter } from '../segmenter'

type SegmenterInternals = {
  handleFrame(frame: Float32Array): void
  preroll: Float32Array[]
  prerollLen: number
  maxSegmentSamples: number
}

function internals(segmenter: AudioSegmenter): SegmenterInternals {
  return segmenter as unknown as SegmenterInternals
}

describe('AudioSegmenter', () => {
  it('連續靜音時將 preroll 記憶體限制在設定長度內', () => {
    const segmenter = new AudioSegmenter({
      sampleRate: 1_000,
      threshold: 0.1,
      prerollMs: 20,
      minSpeechMs: 10,
      minSilenceMs: 20,
      onSegment: vi.fn()
    })
    const impl = internals(segmenter)

    for (let i = 0; i < 1_000; i++) impl.handleFrame(new Float32Array(10))

    expect(impl.prerollLen).toBeLessThanOrEqual(20)
    expect(impl.preroll.reduce((sum, frame) => sum + frame.length, 0)).toBe(impl.prerollLen)
    expect(impl.preroll.length).toBeLessThanOrEqual(2)
  })

  it('以高於門檻的語音長度判定最短段落，不讓尾端靜音墊長短噪音', () => {
    const onSegment = vi.fn()
    const segmenter = new AudioSegmenter({
      sampleRate: 1_000,
      threshold: 0.1,
      prerollMs: 0,
      minSpeechMs: 20,
      minSilenceMs: 20,
      onSegment
    })
    const impl = internals(segmenter)
    const speech = new Float32Array(10).fill(0.5)
    const silence = new Float32Array(10)

    impl.handleFrame(speech)
    impl.handleFrame(silence)
    impl.handleFrame(silence) // 靜音結束段落，但有效語音只有 10ms
    expect(onSegment).not.toHaveBeenCalled()

    impl.handleFrame(speech)
    impl.handleFrame(speech)
    impl.handleFrame(silence)
    impl.handleFrame(silence)
    expect(onSegment).toHaveBeenCalledOnce()
    expect(onSegment.mock.calls[0][0]).toBeInstanceOf(Float32Array)
    expect(onSegment.mock.calls[0][2]).toEqual({
      speechDurationSec: 0.02,
      leadingSilenceSec: 0,
      trailingSilenceSec: 0.02
    })
  })

  it('量出語音時長並分離前置與尾端靜音', () => {
    const onSegment = vi.fn()
    const segmenter = new AudioSegmenter({
      sampleRate: 1_000,
      threshold: 0.1,
      prerollMs: 20,
      minSpeechMs: 10,
      minSilenceMs: 20,
      onSegment
    })
    const impl = internals(segmenter)
    const silence = new Float32Array(10)
    const speech = new Float32Array(10).fill(0.5)

    impl.handleFrame(silence)
    impl.handleFrame(silence)
    impl.handleFrame(silence) // preroll capped to 20 ms
    impl.handleFrame(speech)
    impl.handleFrame(speech)
    impl.handleFrame(silence)
    impl.handleFrame(silence)

    expect(onSegment).toHaveBeenCalledOnce()
    expect(onSegment.mock.calls[0][2]).toEqual({
      speechDurationSec: 0.02,
      leadingSilenceSec: 0.02,
      trailingSilenceSec: 0.02
    })
  })
})

describe('AudioSegmenter 長度上限', () => {
  it('一口氣講不停時到頂就切段,不讓音訊無限累積', () => {
    const onSegment = vi.fn()
    const segmenter = new AudioSegmenter({
      sampleRate: 1_000,
      threshold: 0.1,
      prerollMs: 0,
      minSpeechMs: 0,
      // 靜音門檻設很大:這個測試要量的是「只有長度上限會切」,
      // 若同時被靜音切掉,就分不清是哪一條規則在作用。
      minSilenceMs: 10_000,
      maxSegmentMs: 25,
      onSegment
    })
    const impl = internals(segmenter)
    const speech = new Float32Array(10).fill(0.5)

    for (let i = 0; i < 10; i++) impl.handleFrame(speech)

    // 100 個 sample 依 25ms 一段切:第 30/60/90 個 sample 各切一次,最後 10 個
    // 還在緩衝裡(沒有人停下來 flush),所以是 3 段而不是 4 段。
    expect(onSegment).toHaveBeenCalledTimes(3)
    segmenter.flush()
    expect(onSegment).toHaveBeenCalledTimes(4)
    // 上限是 frame 粒度的:切點落在 frame 邊界,所以一段最多是「上限 + 一個
    // frame」(25 + 10)。**不能**要求 ≤ 25 —— 那等於要求在 frame 中間切開音訊。
    for (const call of onSegment.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(35)
    }
  })

  it('講一整分鐘也不會變成「一個巨無霸段落」(記憶體不會隨講話時間線性成長)', () => {
    const onSegment = vi.fn()
    const segmenter = new AudioSegmenter({
      sampleRate: 1_000,
      threshold: 0.1,
      prerollMs: 0,
      minSpeechMs: 0,
      minSilenceMs: 10_000,
      maxSegmentMs: 100,
      onSegment
    })
    const impl = internals(segmenter)
    const speech = new Float32Array(10).fill(0.5)
    // 60,000 個 sample = 60 秒連續語音(從不靜默)
    for (let i = 0; i < 6_000; i++) impl.handleFrame(speech)

    expect(onSegment.mock.calls.length).toBeGreaterThanOrEqual(500)
    for (const call of onSegment.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(110)
    }
  })

  it('預設上限是 30 秒(Whisper 本身的切片長度,不增加處理成本)', () => {
    const onSegment = vi.fn()
    // sampleRate 明寫 1000,預設 30_000ms → 30000 samples
    const segmenter = new AudioSegmenter({ sampleRate: 1_000, onSegment })
    expect(internals(segmenter).maxSegmentSamples).toBe(30_000)
  })

  it('被長度上限切開的那一段,尾端靜音是 0(不是「講完安靜下來」的語意)', () => {
    const onSegment = vi.fn()
    const segmenter = new AudioSegmenter({
      sampleRate: 1_000,
      threshold: 0.1,
      prerollMs: 0,
      minSpeechMs: 0,
      minSilenceMs: 10_000,
      maxSegmentMs: 25,
      onSegment
    })
    const impl = internals(segmenter)
    for (let i = 0; i < 5; i++) impl.handleFrame(new Float32Array(10).fill(0.5))
    expect(onSegment).toHaveBeenCalled()
    expect(onSegment.mock.calls[0][2].trailingSilenceSec).toBe(0)
  })
})
