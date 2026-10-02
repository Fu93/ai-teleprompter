/**
 * fake-media.mjs — 用 Chromium 的假裝置,把「這個環境量不到」變成量得到。
 *
 * 為什麼需要這一支:
 *   audit-effects 原本有 6 項控制項被歸類成 unverifiable,理由是「需要真的麥克風、
 *   真的相機、真的畫面」。那個分類是誠實的,但它把**產品最核心的路徑**
 *   (錄音 → 辨識 → 逐字稿)整條放進了「沒有人驗過」的箱子裡。
 *   一份報告如果寫著「84 個控制項全綠」而其中一條是錄音,那是比紅燈更危險的綠燈。
 *
 *   Chromium 有假裝置旗標,Electron 也吃(它就是在跑 Chromium)。
 *   `playtest3.spec.ts` 已經證明 `--use-fake-device-for-media-stream` 在這個
 *   App 上有效 —— 那條測試就是靠它跑完「開始聆聽 → 停止並儲存」的。
 *
 * ── 這裡放的是**啟動參數**,不是斷言 ──
 *   每個旗標的意義與它「證明了什麼、沒證明什麼」都寫在下面。斷言在呼叫端。
 *
 *   1. --use-fake-ui-for-media-stream
 *      getUserMedia 不再跳權限對話框(直接給權限)。沒有它,headless 會停在
 *      permission prompt 上,而症狀是「按了開始聆聽之後永遠是啟動中…」——
 *      看起來像產品壞了,其實是量測端沒有回應那個對話框。
 *
 *   2. --use-fake-device-for-media-stream
 *      合成攝影機(滾動的彩條圖)。**它給的畫面裡沒有人臉**,所以 MediaPipe
 *      找不到臉 —— 這一條是刻意的:它讓「相機開得起來、影格有在流」變成
 *      可量測,而「臉部量測」仍然是 unverifiable(理由要寫成「合成影像沒有人臉」,
 *      而不是含糊的「沒有相機」)。
 *
 *   3. --use-file-for-fake-audio-capture=<wav>
 *      把一個 16-bit PCM WAV 當成麥克風輸入。這是「錄音真的有收到聲音」唯一的
 *      量測方式:合成裝置預設餵的是靜音,而靜音無法區分「收音壞了」與「本來就沒人說話」。
 *      檔案由 scripts/make-audio-fixture.mjs 產生(Windows 內建語音,離線)。
 *
 *   4. --auto-select-desktop-capture-source=<title>
 *      getDisplayMedia(螢幕擷取)不再跳來源選擇器,直接選標題符合的視窗。
 *      沒有它,「系統音訊(對方)」那條路徑在 headless 永遠停在選擇器上。
 *
 * ── 為什麼旗標放在 args 而不是 app.commandLine.appendSwitch ──
 *   稽核腳本啟動的是 `electron .`(未打包),Chromium 會收到整份命令列。
 *   放在 args 的好處是:它跟啟動指令在一起,讀的人看得到「這個探針是在什麼
 *   環境下量的」。若某個 Electron 版本不吃某個旗標,fallback 是在 main 端
 *   以 app.commandLine.appendSwitch 補上(只在 AI_TP_E2E 下),而不是改設計。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** fixture 放這裡(gitignore:它是產生物,不進版控)。 */
export const FIXTURE_DIR = resolve(process.cwd(), 'fixtures', 'audit')

/** 假麥克風用的語音檔。內容是一句已知的話,見 make-audio-fixture.mjs。 */
export const AUDIO_FIXTURE = join(FIXTURE_DIR, 'voice-zh.wav')

/** 可選的人臉影片(沒有它,臉部量測仍然是 unverifiable)。 */
export const FACE_FIXTURE = join(FIXTURE_DIR, 'face.y4m')

export const AUDIO_FIXTURE_SENTENCE = '這是稽核用的假麥克風,用來證明錄音真的有收到聲音。'

/**
 * 音訊 fixture 的狀態。呼叫端必須先問這個,再決定要斷言 works 還是
 * 誠實地記 unverifiable —— **不能因為檔案不在就跳過這一條**。
 */
export function audioFixtureStatus() {
  if (!existsSync(AUDIO_FIXTURE)) {
    return {
      ok: false,
      why: `找不到 ${AUDIO_FIXTURE}(執行 npm run make-audio-fixture 產生)`,
      path: AUDIO_FIXTURE
    }
  }
  try {
    const buf = readFileSync(AUDIO_FIXTURE)
    const fmt = parseWavHeader(buf)
    if (!fmt.ok) return { ok: false, why: `${AUDIO_FIXTURE} 格式不符:${fmt.why}`, path: AUDIO_FIXTURE }
    return { ok: true, path: AUDIO_FIXTURE, bytes: buf.length, format: fmt }
  } catch (err) {
    return { ok: false, why: `讀不到 ${AUDIO_FIXTURE}:${err.message}`, path: AUDIO_FIXTURE }
  }
}

/**
 * 檢查 WAV 標頭。為什麼要自己解:
 *   Chromium 的假音訊裝置只吃「16-bit PCM、未壓縮」的 WAV;餵錯格式的結果是
 *   **靜音**而不是錯誤 —— 而那會讓「收音探針」量到 0 之後被誤判成產品缺陷。
 *   在這裡先驗格式,才能把「fixture 壞了」與「產品收不到音」分開。
 */
export function parseWavHeader(buf) {
  if (buf.length < 44) return { ok: false, why: '檔案小於 44 bytes,不是 WAV' }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, why: '沒有 RIFF/WAVE 標頭' }
  }
  const audioFormat = buf.readUInt16LE(20)
  const channels = buf.readUInt16LE(22)
  const bits = buf.readUInt16LE(34)
  const dataSize = buf.readUInt32LE(40)
  if (audioFormat !== 1) return { ok: false, why: `audioFormat=${audioFormat},只接受 1(PCM)` }
  if (bits !== 16) return { ok: false, why: `bits=${bits},只接受 16` }
  if (channels !== 1 && channels !== 2) return { ok: false, why: `channels=${channels}` }
  if (dataSize <= 0) return { ok: false, why: 'data chunk 是空的' }
  // 非靜音檢查:整份資料若都是同一個值,Chromium 會餵出無聲的假訊號。
  let min = 32767
  let max = -32768
  const end = Math.min(44 + dataSize, buf.length)
  for (let i = 44; i + 1 < end; i += 2) {
    const v = buf.readInt16LE(i)
    if (v < min) min = v
    if (v > max) max = v
    if (max - min > 2000) break
  }
  if (max - min <= 1000) return { ok: false, why: `幾乎是靜音(振幅 ${min}..${max})` }
  return { ok: true, channels, bits, sampleRate: buf.readUInt32LE(24), dataSize, amplitude: [min, max] }
}

/**
 * 組出啟動參數。
 *
 * 回傳值一律是**陣列**(包含 args[0] 的 '.' 呼叫端自己加),
 * 讓呼叫端看得到自己多傳了什麼 —— 這在「為什麼這個探針量到 0」的時候很重要。
 */
export function fakeMediaArgs(opts = {}) {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']

  const audio = opts.audio === null ? null : (opts.audio ?? AUDIO_FIXTURE)
  if (audio && existsSync(audio)) args.push(`--use-file-for-fake-audio-capture=${audio}`)

  const face = opts.face ?? FACE_FIXTURE
  if (face && existsSync(face)) args.push(`--use-file-for-fake-video-capture=${face}`)

  if (opts.desktopTitle) args.push(`--auto-select-desktop-capture-source=${opts.desktopTitle}`)

  // 螢幕擷取需要這一個才會真的拿到畫面(Chromium 的擷取路徑預設要求使用者手選)
  if (opts.desktopCapture) args.push('--enable-usermedia-screen-capturing')

  return args
}

/**
 * 一次講清楚「這一輪的假裝置狀態」。
 * 放進報告的 notes:讀報告的人不必去猜這份數字是在什麼環境下量的。
 * opts.audio === null 與 fakeMediaArgs 同語意:刻意不掛假麥克風旗標
 * (self-test 的 drop-fake-audio),summary 必須如實說「沒有」,否則
 * 報告的環境說明會與啟動參數互相矛盾。
 */
export function fakeMediaSummary(opts = {}) {
  if (opts.audio === null) {
    return {
      假麥克風: '沒有 — 這一輪刻意不掛 --use-file-for-fake-audio-capture(self-test 破壞)',
      假攝影機: '合成彩條圖(沒有人臉)',
      人臉fixture: existsSync(opts.face ?? FACE_FIXTURE) ? '有' : `沒有(${FACE_FIXTURE})`,
      桌面擷取: opts.desktopTitle ? `自動選來源「${opts.desktopTitle}」` : '未啟用'
    }
  }
  const audio = audioFixtureStatus()
  const face = existsSync(opts.face ?? FACE_FIXTURE)
  return {
    假麥克風: audio.ok ? `有(${audio.format.sampleRate}Hz ${audio.format.bits}bit)` : `沒有 — ${audio.why}`,
    假攝影機: '合成彩條圖(沒有人臉)',
    人臉fixture: face ? '有' : `沒有(${FACE_FIXTURE})`,
    桌面擷取: opts.desktopTitle ? `自動選來源「${opts.desktopTitle}」` : '未啟用'
  }
}
