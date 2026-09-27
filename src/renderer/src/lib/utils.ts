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
export function degrade(text: string, maxChars: number): string {
  const t = text.trim()
  if (t.length <= maxChars) return t
  return t.slice(0, Math.max(1, maxChars))
}
