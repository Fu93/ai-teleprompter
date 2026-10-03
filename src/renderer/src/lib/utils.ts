export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * formatTransport — 浮層時間列的文案(已播 / 剩餘)。
 *
 * 為什麼要抽成純函式而不是寫在 JSX 裡:原寫法是
 *   `{formatDuration(elapsedSec)} / -{formatDuration(remainingMs / 1000)}`
 * 它在播完時顯示 `0:00 / -0:00` —— 一個負的零,而且沒有任何規則會把
 * 「合法的字串」判成缺陷(audit-ui 六支全綠,這一幕還是稽核自己截圖留下來的:
 * journey 報告的 notes 有 `"0:00 / -0:00"`)。抽出來之後,
 * 「剩餘 0 秒」與「剩餘是負值」這兩件事由測試釘住,不再靠肉眼。
 *
 * 三個決定:
 *   - 負號拿掉。`-1:48` 是「倒數」的常見寫法,但畫面上同時有兩個數字時,
 *     那個減號讀起來像「負的剩餘」而不是「剩下」。改成明講的「已播 / 剩」。
 *   - 剩餘 < 1 秒 → 「已播畢」。顯示「剩 0:00」等於說「還有 0 秒」,
 *     而 0 秒之後就不是還有 —— 那個狀態有自己的名字(藥丸的狀態點也用同一組詞)。
 *   - remainingMs 為 null(bullet 模式是手動推進,沒有剩餘時間可估)時只顯示已播。
 */
export function formatTransport(elapsedSec: number, remainingMs: number | null): string {
  const elapsed = formatDuration(Number.isFinite(elapsedSec) ? elapsedSec : 0)
  // null = 這個模式沒有剩餘時間可估(bullet);NaN/Infinity = 有值但不是一個
  // 可用的時長。兩者都只能顯示已播 —— 讓 `NaN:NaN` 漏到螢幕上比不顯示更糟,
  // 而那正是「先做除法再想」的預設結果。
  if (remainingMs === null || !Number.isFinite(remainingMs)) return `已播 ${elapsed}`
  // 防禦性 clamp:引擎現在會自己 clamp,但這個函式是「時間軸不得出現負值」的
  // 唯一出口,它不該依賴呼叫端。
  const remaining = Math.max(0, remainingMs) / 1000
  if (remaining < 1) return `已播 ${elapsed} · 已播畢`
  return `已播 ${elapsed} · 剩 ${formatDuration(remaining)}`
}

/**
 * 講稿標題的單一出處:存檔、浮層 payload、刪除確認共用。
 *
 * 為什麼需要它:save() 原本自己 trim + 回填「未命名講稿」,而 launch() /
 * beginRecording() 把**未正規化**的 draft.title 送給浮層 —— 空白標題存檔後,
 * 清單寫「未命名講稿」、浮層卻顯示 fallback「提詞浮層」。同一份稿子在兩個
 * 地方有兩個名字,使用者會以為開錯稿。三處共用一個函式,漂移就不可能發生。
 */
export function normalizeScriptTitle(title: string): string {
  return title.trim() || '未命名講稿'
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

let uidCounter = 0
export function uid(): string {
  uidCounter += 1
  return `${Date.now().toString(36)}-${uidCounter}`
}

/**
 * 精度降級取代截斷(Island 慣例):寬度不足時直接降到前 N 字,永不出現「…」。
 * 比起 CSS truncate,保留完整資訊語意(關鍵詞可見即可用),也避免 CJK 斷字位置怪異。
 */
/** 前導標點:從句中切字時會把逗號/句號切進來(「，今天想跟」),顯示前剝掉 */
const LEADING_PUNCT = /^[，。、；：！？「」『』（）．,.:;!?\s]+/

export function degrade(text: string, maxChars: number): string {
  const t = text.trim().replace(LEADING_PUNCT, '')
  if (t.length <= maxChars) return t
  // 切完再剝一次:切點可能正好落在標點上
  return t.slice(0, Math.max(1, maxChars)).replace(LEADING_PUNCT, '')
}
