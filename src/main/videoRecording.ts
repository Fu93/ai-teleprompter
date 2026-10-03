/**
 * videoRecording.ts — 錄影提詞的分片落盤。
 *
 * 為什麼需要這個模組(而不是沿用 `util:save-recording` 一次把整段丟過來):
 *
 *   舊路徑是 renderer 把所有 chunk 攢在 `recChunksRef`,停止時 `blob.arrayBuffer()`
 *   一次性複製、整包過 IPC、main 再 `Buffer.from` 寫入。一段 720p 的長錄影是
 *   幾百 MB 的單點複製 —— 任何一環失敗(記憶體不足、IPC 序列化失敗、使用者
 *   在那瞬間關掉視窗)就是**整段沒了**,而失敗只換到一句 toast。
 *
 *   更關鍵的是「視窗被銷毀」那條路:renderer 一死,`recorder.onstop` 根本不會跑,
 *   連存檔對話框都不會出現。守衛(useCloseGuard)擋得住「使用者按 X」,擋不住
 *   OS 關機、自動更新退出、renderer crash —— 那三種情況下分片**已經在磁碟上**
 *   才是唯一的保險。
 *
 * 所以錄影從 `start(500)` 的第一片開始就往這裡寫,renderer 手上不留副本。
 * 暫存檔是**可以播放的 WebM**(第一片帶 header、後續片接在後面),所以任何時候
 * 進程死掉,留下來的都是一個能播的檔案 —— 啟動時由 listOrphanRecordings() 找回來。
 *
 * 只會有一段錄影是 active(元件層保證),所以這裡用模組層的單一 current,
 * 不讓呼叫端傳 token:token 要防的是「兩段並存」,而那在產品上不存在。
 */
import { app, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { createWriteStream, type WriteStream } from 'fs'
import { mkdir, readdir, rename, copyFile, unlink, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { state } from './state'
import { logMain } from './logging'

/** 暫存目錄:與 userData 分開 —— 它不是使用者資料,清掉不該被讀成刪資料 */
function tempDir(): string {
  return join(app.getPath('temp'), 'ai-teleprompter-recordings')
}

/** 「保留」時的目的地:與錄影正常存檔的預設資料夾同一個地方 */
function videosDir(): string {
  return join(app.getPath('videos'), 'AI 提詞機')
}

interface Active {
  path: string
  stream: WriteStream
  bytes: number
  /** 寫入失敗(磁碟滿/唯讀)後設起來。之後的 chunk 直接拒絕 —— 繼續收下去
   *  等於假裝還在錄,而畫面上的計時器照樣在走。 */
  failed: string | null
}

let current: Active | null = null
/** 最近一次 finish 收掉的暫存檔。save 只認它 —— 從目錄裡「挑一個」會在
 *  上一次的檔沒清乾淨時存錯東西。 */
let lastFinished: string | null = null

function liveWindow(): BrowserWindow | null {
  const win = state.mainWindow
  return win && !win.isDestroyed() ? win : null
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** rename 跨裝置(EXDEV)時退回 copy+unlink。temp 與使用者資料夾常在不同磁碟。 */
async function moveFile(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM') throw err
    await copyFile(src, dst)
    await unlink(src)
  }
}

/** 目的地已存在就補 -1 / -2…:覆寫使用者的影片比多一個檔糟得多 */
async function uniquePath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = join(dir, name)
  for (let i = 1; ; i++) {
    try {
      await stat(candidate)
      candidate = join(dir, `${base}-${i}${ext}`)
    } catch {
      return candidate
    }
  }
}

export interface VideoRecordingResult {
  ok: boolean
  filePath?: string
  autoSaved?: boolean
  /**
   * 預覽用的檔名(app://rec/<previewName>)。
   * 只有當檔案落在兩個可服務根目錄之一時才帶,所以 renderer 可以用
   * `previewable === false` 明確降級成「只給路徑 + 開啟資料夾」,
   * 而不是擺一個永遠轉不出畫面的 player。
   */
  previewName?: string
  previewable?: boolean
  error?: string
}

/** 與 appProtocol.ts 的 recordingRoots() 同一份規則;改一邊就要改兩邊 */
function isPreviewable(p: string): boolean {
  const roots = [tempDir(), videosDir()]
  const norm = p.replace(/\\/g, '/')
  return roots.some((r) => norm.startsWith(r.replace(/\\/g, '/')))
}

function previewFields(p: string): Pick<VideoRecordingResult, 'previewName' | 'previewable'> {
  const name = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)
  return { previewName: name, previewable: isPreviewable(p) }
}

export async function beginVideoRecording(): Promise<VideoRecordingResult> {
  // 上一段還沒收尾(理論上不會,但沒收的 handle 會讓暫存目錄一直長大)
  if (current) await abortVideoRecording()
  const dir = tempDir()
  await ensureDir(dir)
  lastFinished = null
  const path = join(dir, `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`)
  const stream = createWriteStream(path, { flags: 'wx' })
  const failed: string | null = await new Promise((resolve) => {
    stream.once('open', () => resolve(null))
    stream.once('error', (err: Error) => resolve(err.message))
  })
  if (failed) {
    stream.destroy()
    await unlink(path).catch(() => undefined)
    return { ok: false, error: failed }
  }
  current = { path, stream, bytes: 0, failed: null }
  return { ok: true }
}

export async function appendVideoChunk(bytes: Uint8Array): Promise<VideoRecordingResult> {
  const active = current
  if (!active) return { ok: false, error: '沒有進行中的錄影' }
  if (active.failed) return { ok: false, error: active.failed }
  const buf = Buffer.from(bytes)
  active.bytes += buf.byteLength
  if (active.stream.write(buf)) return { ok: true }
  // 背壓:WriteStream 自己排隊,這裡等它可寫 —— 不等的話長錄影會把 IPC 變成無限佇列
  await new Promise<void>((resolve) => {
    active.stream.once('drain', () => resolve())
    active.stream.once('error', () => resolve())
  })
  return active.failed ? { ok: false, error: active.failed } : { ok: true }
}

async function closeActive(): Promise<{ path: string; bytes: number; failed: string | null } | null> {
  const active = current
  if (!active) return null
  current = null
  const result = { path: active.path, bytes: active.bytes, failed: active.failed }
  if (active.failed) {
    active.stream.destroy()
    return result
  }
  await new Promise<void>((resolve) => {
    active.stream.once('error', () => resolve())
    active.stream.end(() => resolve())
  })
  return result
}

/** 收尾但**不刪檔**:檔案留在暫存區,等 save / abort 決定。 */
export async function finishVideoRecording(): Promise<{ ok: boolean; bytes: number; error?: string }> {
  const closed = await closeActive()
  if (!closed) return { ok: false, bytes: 0, error: '沒有進行中的錄影' }
  if (closed.failed) {
    lastFinished = closed.path
    return { ok: false, bytes: closed.bytes, error: closed.failed }
  }
  if (closed.bytes === 0) {
    await unlink(closed.path).catch(() => undefined)
    lastFinished = null
    return { ok: false, bytes: 0, error: 'empty' }
  }
  lastFinished = closed.path
  return { ok: true, bytes: closed.bytes }
}

/**
 * 彈存檔對話框,把暫存檔移過去。
 *
 * 「取消」不等於「丟掉」:這是舊版最傷的一條 —— 使用者按取消只表示
 * 「不想存到那個路徑」,卻換到整段錄影被刪掉。現在取消會再問一次,
 * 而且**預設選項是保留**(存到預設資料夾)。要真的不要,得明確選「放棄」。
 */
export async function saveVideoRecording(defaultName: string): Promise<VideoRecordingResult> {
  if (!lastFinished) return { ok: false, error: '錄影暫存檔已不存在' }
  const tempPath = lastFinished
  lastFinished = null

  const opts = {
    defaultPath: join(await ensureVideosThenDir(), defaultName),
    filters: [{ name: '影片', extensions: ['webm', 'mp4'] }]
  }
  const win = liveWindow()
  const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)

  if (canceled || !filePath) {
    const box = {
      type: 'warning' as const,
      buttons: ['存到預設資料夾', '放棄這段錄影'],
      defaultId: 0,
      cancelId: 1,
      title: '這段錄影要保留嗎？',
      message: '你取消了另存,這段錄影還沒有寫進任何地方。',
      detail: '選「存到預設資料夾」會把它放到「影片/AI 提詞機」;選「放棄」才會真的刪掉。'
    }
    const pick = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box)
    if (pick.response === 0) {
      try {
        const dir = await ensureVideosThenDir()
        const dst = await uniquePath(dir, defaultName)
        await moveFile(tempPath, dst)
        return { ok: true, filePath: dst, autoSaved: true, ...previewFields(dst) }
      } catch (err) {
        // 保留失敗:檔還在暫存區,啟動時還找得回來 —— 說清楚而不是刪掉
        lastFinished = tempPath
        const msg = err instanceof Error ? err.message : String(err)
        logMain('ERROR', `錄影存到預設資料夾失敗:${msg}`)
        return { ok: false, error: msg }
      }
    }
    await unlink(tempPath).catch(() => undefined)
    return { ok: false, error: 'discarded' }
  }

  try {
    await ensureDir(dirname(filePath))
    // 對話框在覆寫前已經問過一次,所以直接寫
    await moveFile(tempPath, filePath)
    return { ok: true, filePath, ...previewFields(filePath) }
  } catch (err) {
    lastFinished = tempPath
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function ensureVideosThenDir(): Promise<string> {
  const dir = videosDir()
  await ensureDir(dir)
  return dir
}

/** 放棄(錄影失敗、元件卸載、使用者明確不要):刪暫存檔。 */
export async function abortVideoRecording(): Promise<void> {
  const closed = await closeActive()
  if (closed) await unlink(closed.path).catch(() => undefined)
  if (lastFinished) {
    await unlink(lastFinished).catch(() => undefined)
    lastFinished = null
  }
}

export interface OrphanRecording {
  path: string
  bytes: number
}

/** 啟動時找回來的未完成錄影(進程在錄影中死掉留下的) */
export async function listOrphanRecordings(): Promise<OrphanRecording[]> {
  const dir = tempDir()
  const files = await readdir(dir).catch(() => [] as string[])
  const out: OrphanRecording[] = []
  for (const f of files) {
    if (!f.startsWith('rec-') || !f.endsWith('.webm')) continue
    const p = join(dir, f)
    try {
      const s = await stat(p)
      // 0 位元組 = 開了檔但一片都沒寫進去,那不是「未完成的錄影」
      if (s.size > 0) out.push({ path: p, bytes: s.size })
    } catch {
      /* 檔在列出與 stat 之間被刪:略過 */
    }
  }
  return out
}

export async function resolveOrphanRecordings(
  mode: 'keep' | 'discard'
): Promise<{ ok: boolean; moved?: number; error?: string }> {
  const orphans = await listOrphanRecordings()
  if (mode === 'discard') {
    for (const o of orphans) await unlink(o.path).catch(() => undefined)
    return { ok: true, moved: 0 }
  }
  try {
    const dir = await ensureVideosThenDir()
    let moved = 0
    for (const o of orphans) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      const dst = await uniquePath(dir, `未完成錄影-${stamp}.webm`)
      await moveFile(o.path, dst)
      moved += 1
    }
    return { ok: true, moved }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logMain('ERROR', `未完成錄影存回失敗:${msg}`)
    return { ok: false, error: msg }
  }
}
