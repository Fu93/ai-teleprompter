import { describe, expect, it, vi } from 'vitest'
import { AudioSegmenter } from '../segmenter'

type SegmenterInternals = {
  handleFrame(frame: Float32Array): void
  preroll: Float32Array[]
  prerollLen: number
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
