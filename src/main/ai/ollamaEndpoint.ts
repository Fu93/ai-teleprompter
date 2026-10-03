/**
 * ollamaEndpoint.ts — Ollama endpoint 正規化 + SSRF 防護(自 flowprompt-v3 移植)
 *
 * 只允許 loopback / 私有網段;阻擋雲端 metadata、link-local、CGNAT、
 * multicast、reserved 等可被用於 SSRF 的位址。
 */
import { canonicalHost, isIPv6Host, mappedIPv4FromIPv6 } from './ipHost'

export const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434/api/chat'

const PRIVATE_IPV4_RE = /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./

function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost')
  )
}

export function isBlockedSSRFIPv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const nums: number[] = []
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return false
    nums.push(n)
  }
  const [a, b] = nums
  if (a === 169 && b === 254) return true // link-local metadata(169.254.169.254 等)
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224 && a <= 239) return true // multicast
  if (a >= 240) return true // reserved
  if (a === 0) return true // 0.0.0.0/8
  return false
}

export function isBlockedSSRFHost(hostRaw: string): boolean {
  const host = canonicalHost(hostRaw)

  if (host === '0.0.0.0' || host === '::' || host === '::0') return true

  // IPv4-mapped / compatible IPv6 必須遞迴檢查。
  //
  // 為什麼這裡不能只比字串:`new URL('http://[::ffff:169.254.169.254]/').hostname`
  // 回傳的是 **hex 形狀** `[::ffff:a9fe:a9fe]`,不是點號形狀。原本的
  // /^::ffff:(.+)$/ 只認點號形狀,所以這條防護在真實呼叫路徑上從來沒生效過 ——
  // 而單元測試直接餵字串,所以看起來是綠的(見 ipHost.ts 檔頭)。
  const mapped = mappedIPv4FromIPv6(host)
  if (mapped !== null) return isBlockedSSRFIPv4(mapped)

  if (isIPv6Host(host)) {
    // IPv6 unique-local fc00::/7
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
    // IPv6 link-local fe80::/10
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true
    return false // 其他 IPv6(非本模組管轄;正規化階段僅允許 ::1)
  }

  return isBlockedSSRFIPv4(host)
}

/**
 * 正規化使用者輸入的 Ollama 位址為 /api/chat 絕對路徑。
 * 回傳 null 表示位址無效或被 SSRF 規則阻擋。
 *
 * 行為(忠實保留 v3):`/api/generate` 結尾會變成 `/api/generate/api/chat`;
 * 呼叫端應只傳 origin / /api / /api/chat 三種形態。
 */
export function normalizeOllamaEndpointUrl(raw: unknown): string | null {
  if (!raw || typeof raw !== 'string') return OLLAMA_DEFAULT_ENDPOINT

  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = canonicalHost(url.hostname)
  const isPrivate = PRIVATE_IPV4_RE.test(host)
  if (!isLoopbackHost(host) && !isPrivate) return null
  if (isBlockedSSRFHost(host)) return null

  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/api/chat')) {
    // 原樣
  } else if (path.endsWith('/api')) {
    path += '/chat'
  } else {
    path += '/api/chat'
  }

  return `${url.protocol}//${url.host}${path}${url.search}`
}
