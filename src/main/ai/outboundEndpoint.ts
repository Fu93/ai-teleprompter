/**
 * outboundEndpoint.ts — 出站 AI 端點的統一政策(雲端 / openai-compatible / STT)
 *
 * 為什麼需要這個檔:安全政策集中在一個地方才叫政策。o11amaEndpoint.ts 早就有
 * 一套 SSRF 判定,但它只被 aiProvider.resolveEndpoint() 用到;而 renderer 實際
 * 走的是 ipc.ts 的 OpenAiChat / CloudTranscribe,那兩條路徑原本是字串拼接後
 * 直接 fetch()。結果是「同一份設定,按測試連線與按開始提詞會得到不同的安全判定」
 * —— 使用者無從預測,也無從除錯。
 *
 * 為什麼雲端端點不能用 ollama 那套「只准 loopback + 私網」的白名單:
 * 雲端 API 的本來用途就是公網網址,而且把 openai-compatible 指向區網自架的
 * vLLM / LM Studio / Tailscale 主機是這個產品的**正常使用方式**(e2e 自己的
 * mock 伺服器也跑在 127.0.0.1)。用白名單擋會直接弄壞它。
 *
 * 所以這裡改用黑名單,只擋「沒有任何一種情況下會是合法 AI 端點」的位址:
 *   - link-local 169.254.0.0/16(雲端 metadata 與 AWS/GCP/Azure IMDS 都在這裡)
 *   - 未指定位址 0.0.0.0 / ::
 *   - multicast 與 reserved(240.0.0.0/4)
 *   - 內嵌憑證(http://user:pass@host):這是釣魚常見手法,而且我們自己送的
 *     Authorization 標頭會蓋掉它,留著只會讓人誤以為有在驗證。
 *
 * 刻意**不**擋的兩段,理由寫在下面常數旁邊,不要「看起來不對就補上」。
 */
import { canonicalHost, isIPv6Host, mappedIPv4FromIPv6 } from './ipHost'

/** 拒絕原因。給使用者看的訊息在呼叫端組成,這裡只提供穩定的代碼。 */
export type OutboundDenyReason = 'invalid-url' | 'scheme' | 'credentials' | 'blocked-host'

/**
 * 判別式 union:`if (!r.ok) r.reason` 之後 TypeScript 就知道 r.url 一定是
 * string。刻意不用 `{ ok: boolean; url: string | null }` —— 那個形狀會讓每個
 * 使用點都要自己再斷言一次非 null,而這個型別存在的目的就是讓那個斷言只寫一次。
 */
export type OutboundEndpointOutcome =
  | { ok: true; url: string }
  | { ok: false; reason: OutboundDenyReason }

/** 從未指定位址。指向它等於指向本機所有介面卡,是誤植而不是目的地。 */
const UNSPECIFIED_HOSTS = new Set(['0.0.0.0', '::', '::0'])

/**
 * 只擋 169.254/16(link-local)、multicast、reserved。
 *
 * 為什麼不用 ollamaEndpoint 的 isBlockedSSRFIPv4:那一版連 100.64.0.0/10(CGNAT)
 * 一起擋,那是 Ollama 的刻意選擇(見該檔)。但對雲端/自架端點來說,CGNAT 與
 * fc00::/7(ULA)分別是 Tailscale 與 Docker 的預設位段 —— 擋掉等於擋掉最常見的
 * 區網自架 AI 伺服器。兩邊政策不同是刻意的,不是漏抄。
 */
function isDenyListedIPv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const nums: number[] = []
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return false
    nums.push(n)
  }
  const [a, b] = nums
  if (a === 169 && b === 254) return true // link-local:雲端 metadata
  if (a >= 224 && a <= 239) return true // multicast
  if (a >= 240) return true // reserved
  return false
}

function isDenyListedHost(hostRaw: string): boolean {
  const host = canonicalHost(hostRaw)
  if (UNSPECIFIED_HOSTS.has(host)) return true

  // IPv4-mapped 遞迴檢查。少了這一步,[::ffff:169.254.169.254] 會看起來像一個
  // 「普通的 IPv6」而通過 —— 而且 URL 解析器給的正是這種寫法(見 ipHost.ts)。
  const mapped = mappedIPv4FromIPv6(host)
  if (mapped !== null) return isDenyListedIPv4(mapped)

  if (isIPv6Host(host)) {
    // IPv6 link-local fe80::/10
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true
    return false
  }

  return isDenyListedIPv4(host)
}

/**
 * 正規化一個使用者設定的雲端端點,並接上呼叫端要的路徑後綴。
 *
 * suffix 一定要由**呼叫端**提供,不要讓它在這裡猜:chat 與 STT 的路徑不同
 * (/chat/completions vs /audio/transcriptions),而把後綴藏進參數預設值只會
 * 讓後來的人以為 baseUrl 本身就是最終 URL。
 */
export function normalizeCloudEndpointUrl(raw: unknown, suffix: string): OutboundEndpointOutcome {
  const deny = (reason: OutboundDenyReason): OutboundEndpointOutcome => ({ ok: false, reason })

  if (!raw || typeof raw !== 'string') return deny('invalid-url')

  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return deny('invalid-url')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return deny('scheme')
  if (url.username || url.password) return deny('credentials')
  if (isDenyListedHost(url.hostname)) return deny('blocked-host')

  // query / fragment 對 base URL 沒有意義(它們描述的是「某一支資源」而不是
  // 「伺服器的根」),而且拼在後綴前面會讓最終 URL 變成
  // https://host/v1?x=1/chat/completions —— 路徑整段掉進 query。使用者看到的是
  // 一個沒有原因的 404。直接丟掉,讓設定頁的「測試連線」如實反映 base。
  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  return { ok: true, url: `${base}${suffix}` }
}

/** 對應 OutboundDenyReason 的人話。放在這裡是為了讓每個拒絕理由都有解釋。 */
export const OUTBOUND_DENY_MESSAGE: Record<OutboundDenyReason, string> = {
  'invalid-url': 'API 位址格式不正確,請填完整的網址(例如 https://api.example.com/v1)',
  scheme: '只支援 http:// 與 https:// 的 API 位址',
  credentials: 'API 位址裡不可以包含帳號密碼,請把驗證放在 API Key 欄位',
  'blocked-host': '這個位址看起來是雲端 metadata 或保留網段,不能當作 API 位址'
}

/** 把拒絕結果轉成使用者看得懂的訊息。呼叫端只需要這一個函式。 */
export function describeOutboundDenial(reason: OutboundDenyReason): string {
  return OUTBOUND_DENY_MESSAGE[reason]
}
