/**
 * ipHost.ts — 位址字串的低階解析(SSRF 防護的共用底層)
 *
 * 為什麼要有這個檔:IPv4-mapped IPv6 有兩種寫法,而 `new URL()` 只會給你其中
 * 一種。`http://[::ffff:169.254.169.254]/` 經 WHATWG URL 解析後 hostname 變成
 * `[::ffff:a9fe:a9fe]` —— **十六進位**。所以任何用 `/^::ffff:(.+)$/` 去抓
 * 內嵌 IPv4 的寫法,在真實的呼叫路徑上永遠不會命中,等於沒有防護。
 * (這個洞是寫測試時被逼出來的:原本 ollamaEndpoint 的單元測試直接餵點號型態,
 * 測試是綠的,實際上擋不住。)
 *
 * 這個檔只做解析,不做政策 —— 允許什麼、擋什麼由呼叫端決定。政策不集中在一個
 * 地方就不叫政策。
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** 把點號四段轉成 4 個 byte;任一段 >255 或不是數字回 null。 */
export function ipv4ToBytes(ip: string): number[] | null {
  const m = IPV4_RE.exec(ip)
  if (!m) return null
  const bytes: number[] = []
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i])
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    bytes.push(n)
  }
  return bytes
}

/**
 * 把 IPv6 字串展開成 8 個 16-bit group,失敗回 null。
 *
 * 支援 `::` 壓縮、結尾的點號四段、以及 zone id(`%eth0`)。回傳 null 而不是
 * 猜:猜錯會讓一個本來該被擋的位址看起來合法。
 */
export function expandIPv6(hostRaw: string): number[] | null {
  // zone id 是本地介面的標籤,不影響位址本身,而且 new URL() 會保留它。
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (!host.includes(':')) return null

  const halves = host.split('::')
  if (halves.length > 2) return null

  const toGroups = (part: string): number[] | null => {
    if (part === '') return []
    const tokens = part.split(':')
    const out: number[] = []
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      // 點號四段只允許出現在最後一段(它佔滿 2 個 group)
      if (t.includes('.')) {
        if (i !== tokens.length - 1) return null
        const bytes = ipv4ToBytes(t)
        if (!bytes) return null
        out.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(t)) return null
      out.push(parseInt(t, 16))
    }
    return out
  }

  const head = toGroups(halves[0])
  if (head === null) return null

  if (halves.length === 1) {
    return head.length === 8 ? head : null
  }

  const tail = toGroups(halves[1])
  if (tail === null) return null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null // `::` 必須真的壓縮掉至少一個 group
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

/**
 * 若這是 IPv4-mapped / IPv4-compatible IPv6(::ffff:a.b.c.d 或 ::ffff:XXXX:XXXX
 * 與 ::a.b.c.d),回傳它映射的點號 IPv4;否則回 null。
 *
 * 兩種寫法都要認:URL 解析器給的是十六進位那種,而手寫字串常是點號那種。
 */
export function mappedIPv4FromIPv6(hostRaw: string): string | null {
  const groups = expandIPv6(hostRaw)
  if (!groups) return null
  // ::ffff:a.b.c.d → 前 5 個 group 全 0,第 6 個是 0xffff
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
  // ::a.b.c.d → 前 6 個 group 全 0(IPv4-compatible,含 ::1 這個特例要另外排除)
  const compat = groups.slice(0, 6).every((g) => g === 0) && groups[6] !== 0
  if (!mapped && !compat) return null
  const hi = groups[6]
  const lo = groups[7]
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/** 這個字串是 IPv6(含 IPv4-mapped)嗎? */
export function isIPv6Host(hostRaw: string): boolean {
  return expandIPv6(hostRaw) !== null
}

/** 正規化成比對時要用的樣子:小寫、去方括號、去 zone id。 */
export function canonicalHost(hostRaw: string): string {
  return hostRaw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
}
