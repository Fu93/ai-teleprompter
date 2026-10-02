/**
 * make-audio-fixture.mjs — 產生「假麥克風」要用的 WAV(離線,不連網)。
 *
 * 為什麼要有這一步:
 *   錄音是這個 App 的核心路徑之一,而它原本被歸類成 unverifiable ——
 *   理由是 headless 沒有麥克風。用 Chromium 的
 *   `--use-file-for-fake-audio-capture` 可以餵一段 WAV 進去,但那段 WAV 必須
 *   存在、必須是 16-bit PCM、而且**必須不是靜音**。
 *
 *   最後一點是關鍵:餵靜音的結果不是錯誤,是「量到 0 的振幅」——
 *   而 0 振幅既可能是產品收不到音(真缺陷),也可能是 fixture 本身就是無聲的
 *   (量測端的錯)。所以 fixture 產生時就先把「非靜音」驗掉,讓探針量到的
 *   0 只能有一種意思。
 *
 * 產生方式(依序嘗試,全部離線):
 *   1. Windows 內建語音(System.Speech / SAPI):合成一句已知的話。
 *      **優先**,因為它是真的語音,之後若有人把它接到真實 Whisper 也能用。
 *   2. 沒有語音引擎時:合成一段「類語音」的振幅調變波形。
 *      它只夠證明「收音路徑有拿到非零訊號」,不夠餵真的辨識模型 ——
 *      報告裡會照實寫是哪一種(見 fixtureKind)。
 *
 * 執行:npm run make-audio-fixture
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUDIO_FIXTURE,
  AUDIO_FIXTURE_SENTENCE,
  FIXTURE_DIR,
  audioFixtureStatus,
  parseWavHeader
} from './lib/fake-media.mjs'

const SAMPLE_RATE = 16000

/** 16-bit PCM mono WAV。與 src/renderer/src/lib/audio/wav.ts 的規格一致。 */
function encodeWav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2)
  }
  return buf
}

/**
 * 類語音波形:多個共振峰的合成音 + 音節包絡。
 * 目的不是「聽起來像人」,是「振幅真的在動」—— 探針量的是 RMS 與過零率,
 * 而單一頻率的正弦波在門檻判斷上與靜音太接近(容易寫出一個永遠矇到的門檻)。
 */
function syntheticSpeech(seconds = 4) {
  const n = SAMPLE_RATE * seconds
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    // 音節包絡:每 0.28 秒一個音節,前後各 40ms 淡入淡出
    const syl = t % 0.28
    const env = syl < 0.04 ? syl / 0.04 : syl > 0.24 ? Math.max(0, (0.28 - syl) / 0.04) : 1
    const f0 = 120 + 25 * Math.sin(2 * Math.PI * 1.7 * t) // 基頻微微起伏
    out[i] =
      env *
      0.5 *
      (Math.sin(2 * Math.PI * f0 * t) +
        0.6 * Math.sin(2 * Math.PI * f0 * 2.1 * t) +
        0.35 * Math.sin(2 * Math.PI * f0 * 3.3 * t) +
        0.12 * Math.sin(2 * Math.PI * 900 * t))
  }
  return out
}

/** 用 Windows 內建語音合成。回傳 true 表示成功產檔。 */
function tryWindowsSapi(outPath) {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    // 有中文語音就選它(沒有也能跑,英文語音合成的仍是「非靜音的真實語音」)
    '$zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh*" } | Select-Object -First 1',
    'if ($zh) { $s.SelectVoice($zh.VoiceInfo.Name) }',
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$s.SetOutputToWaveFile('${outPath.replace(/'/g, "''")}', $fmt)`,
    `$s.Speak('${AUDIO_FIXTURE_SENTENCE.replace(/'/g, "''")}')`,
    '$s.Dispose()',
    'Write-Output "OK"'
  ].join('; ')

  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: 'pipe', timeout: 60_000 }
    )
    return true
  } catch (err) {
    console.log(`   Windows 語音合成不可用:${String(err.message || err).split('\n')[0]}`)
    return false
  }
}

/**
 * 兩段式假麥克風:把語音從中間剪開,中間與尾端各插一段靜音。
 *
 * 為什麼需要這個（除了「錄音要有聲音」之外的第二個理由）:
 *   VAD 是在**靜音**時收掉一段的（minSilenceMs）。而 `--use-fake-device-for-media-stream`
 *   與 voice-zh.wav 都是連續語音,整段只會被切出**一段** —— 麥克風與系統音訊
 *   併發辨識時的「完成順序 ≠ 送出順序」這個情況根本不會發生,e2e 只能測到
 *   一段、變成一個「測不到亂序的綠燈」。中段插靜音讓 VAD 自然切兩段,
 *   亂序的前提才真正成立。
 *
 * 插多長:1.2s 中段（遠大於預設 minSilenceMs）,0.6s 尾端（讓第二段有收尾）。
 */
const MID_SILENCE_SEC = 1.2
const TAIL_SILENCE_SEC = 0.6
export const TWO_SEG_FIXTURE = join(FIXTURE_DIR, 'voice-2seg.wav')

function makeTwoSegFixture() {
  const buf = readFileSync(AUDIO_FIXTURE)
  const parsed = parseWavHeader(buf)
  if (!parsed.ok) {
    console.log(`   voice-zh.wav 不合格(${parsed.why}),略過兩段式 fixture`)
    return
  }
  // 這個 fixture 固定為 16bit mono(encodeWav 與 SAPI 輸出一致);不符就不硬幹
  if (parsed.channels !== 1) {
    console.log(`   voice-zh.wav 是 ${parsed.channels} 聲道,略過兩段式 fixture(需要 mono)`)
    return
  }
  // 這個專案的 WAV 全部是標準 44-byte 標頭,data 從 44 開始（見 encodeWav）
  const end = Math.min(44 + parsed.dataSize, buf.length)
  const frames = Math.floor((end - 44) / 2)
  if (frames < 4) {
    console.log('   voice-zh.wav 的樣本太少,略過兩段式 fixture')
    return
  }
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) samples[i] = buf.readInt16LE(44 + i * 2) / 0x8000

  const cut = Math.floor(frames / 2)
  const midFrames = Math.floor(SAMPLE_RATE * MID_SILENCE_SEC)
  const tailFrames = Math.floor(SAMPLE_RATE * TAIL_SILENCE_SEC)
  const combined = new Float32Array(cut + midFrames + (frames - cut) + tailFrames)
  combined.set(samples.subarray(0, cut), 0)
  combined.set(samples.subarray(cut), cut + midFrames)

  writeFileSync(TWO_SEG_FIXTURE, encodeWav(combined))
  console.log(`\n✓ ${TWO_SEG_FIXTURE}`)
  console.log(
    `   兩段式 · ${(combined.length / SAMPLE_RATE).toFixed(1)}s · 中段靜音 ${MID_SILENCE_SEC}s · 尾端靜音 ${TAIL_SILENCE_SEC}s`
  )
  console.log('   e2e/practice-generation.spec.ts 用它讓 VAD 自然切出兩段(亂序的前提)。')
}

function main() {
  mkdirSync(FIXTURE_DIR, { recursive: true })

  let kind = 'synthetic'
  if (process.platform === 'win32' && tryWindowsSapi(AUDIO_FIXTURE)) {
    kind = 'speech'
  } else {
    console.log('   改用合成波形(只證明收音路徑有訊號,不能餵真辨識模型)')
    writeFileSync(AUDIO_FIXTURE, encodeWav(syntheticSpeech()))
  }

  const st = audioFixtureStatus()
  if (!st.ok) {
    console.error(`\n✗ fixture 產生失敗:${st.why}`)
    rmSync(AUDIO_FIXTURE, { force: true })
    process.exit(1)
  }
  console.log(`\n✓ ${AUDIO_FIXTURE}`)
  console.log(`   ${kind === 'speech' ? '真實語音(Windows SAPI)' : '合成波形'} · ` +
    `${(st.bytes / 1024).toFixed(1)} KB · ${st.format.sampleRate}Hz ${st.format.bits}bit ` +
    `${st.format.channels === 1 ? 'mono' : 'stereo'} · 振幅 ${st.format.amplitude[0]}..${st.format.amplitude[1]}`)
  console.log('   audit:effects 會把這一段當成麥克風輸入。')

  makeTwoSegFixture()
}

main()
