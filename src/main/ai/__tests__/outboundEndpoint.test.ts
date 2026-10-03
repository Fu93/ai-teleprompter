import { describe, it, expect } from 'vitest'
import {
  normalizeCloudEndpointUrl,
  describeOutboundDenial,
  type OutboundDenyReason
} from '../outboundEndpoint'

/** 測試用捷徑:只看 ok,不關心 url —— 各條測試各自斷言 url。 */
const denied = (raw: unknown, suffix = '/chat/completions'): OutboundDenyReason => {
  const r = normalizeCloudEndpointUrl(raw, suffix)
  if (r.ok) throw new Error(`預期被拒絕,但通過了:${r.url}`)
  return r.reason
}

describe('normalizeCloudEndpointUrl — 允許的路徑', () => {
  it('公網 https 端點接上後綴', () => {
    const r = normalizeCloudEndpointUrl('https://api.example.com/v1', '/chat/completions')
    expect(r).toEqual({ ok: true, url: 'https://api.example.com/v1/chat/completions' })
  })

  it('尾斜線與 query / fragment 都不影響最終路徑', () => {
    // 這是實際踩過的形狀:query 與 fragment 描述的是「某一支資源」而不是
    // 「伺服器的根」,拼在後綴前面會讓路徑整段掉進 query。
    expect(normalizeCloudEndpointUrl('https://api.example.com/v1/?x=1#f', '/audio/transcriptions')).toEqual({
      ok: true,
      url: 'https://api.example.com/v1/audio/transcriptions'
    })
  })

  // 這三條是「不能擋」的具體證據:擋掉它們等於弄壞正常使用方式。
  // e2e 自己的 mock STT / mock LLM 也跑在 127.0.0.1,白名單化會讓整套 e2e 紅掉。
  it('loopback / 私網 / CGNAT(Tailscale)/ ULA(Docker)都必須允許', () => {
    for (const host of [
      'http://127.0.0.1:8080/v1',
      'http://localhost:11434/v1',
      'http://192.168.1.50:8000/v1',
      'http://10.0.0.9:8000/v1',
      'http://100.101.102.103:11434/v1',
      'http://[fd00::1]:8000/v1'
    ]) {
      expect(normalizeCloudEndpointUrl(host, '/v1' + '/x').ok, host).toBe(true)
    }
  })

  it('不同後綴給出不同 URL(chat / STT 共用同一政策但不同路徑)', () => {
    const base = 'https://api.groq.com/openai/v1'
    expect(normalizeCloudEndpointUrl(base, '/chat/completions')).toEqual({
      ok: true,
      url: 'https://api.groq.com/openai/v1/chat/completions'
    })
    expect(normalizeCloudEndpointUrl(base, '/audio/transcriptions')).toEqual({
      ok: true,
      url: 'https://api.groq.com/openai/v1/audio/transcriptions'
    })
  })
})

describe('normalizeCloudEndpointUrl — 拒絕的路徑', () => {
  it('非 http(s) 協定', () => {
    expect(denied('file:///etc/passwd')).toBe('scheme')
    expect(denied('ftp://api.example.com/v1')).toBe('scheme')
    expect(denied('javascript:alert(1)')).toBe('scheme')
  })

  it('非法 / 缺漏的位址', () => {
    expect(denied('not a url')).toBe('invalid-url')
    expect(denied('')).toBe('invalid-url')
    expect(denied(null)).toBe('invalid-url')
    expect(denied(undefined)).toBe('invalid-url')
    expect(denied(123)).toBe('invalid-url')
  })

  it('link-local / metadata(這是 SSRF 的實際目標)', () => {
    expect(denied('http://169.254.169.254/latest/meta-data/')).toBe('blocked-host')
    expect(denied('http://169.254.1.1/v1')).toBe('blocked-host')
    expect(denied('http://[fe80::1]/v1')).toBe('blocked-host')
    // IPv4-mapped:不遞迴檢查就會看起來像普通 IPv6 而通過
    expect(denied('http://[::ffff:169.254.169.254]/v1')).toBe('blocked-host')
  })

  it('未指定位址 / multicast / reserved', () => {
    expect(denied('http://0.0.0.0:8000/v1')).toBe('blocked-host')
    expect(denied('http://[::]:8000/v1')).toBe('blocked-host')
    expect(denied('http://224.0.0.1/v1')).toBe('blocked-host')
    expect(denied('http://240.0.0.1/v1')).toBe('blocked-host')
  })

  it('URL 內嵌帳號密碼', () => {
    expect(denied('https://user:pass@api.example.com/v1')).toBe('credentials')
  })
})

describe('normalizeCloudEndpointUrl — 經過 new URL 之後(真實呼叫路徑)', () => {
  /**
   * 這一組是防Regression用的,不是裝飾。
   *
   * 原先的防護用 /^::ffff:(.+)$/ 抓內嵌 IPv4,但 WHATWG URL 解析會把
   * [::ffff:169.254.169.254] 正規化成 **hex 形狀** [::ffff:a9fe:a9fe],
   * 那條 regex 永遠不命中。只餵字串的單元測試會是綠的,實際上是空的。
   */
  it('URL 解析後的 hex 形狀 IPv4-mapped 仍然被擋', () => {
    const url = new URL('http://[::ffff:169.254.169.254]/latest/meta-data/')
    // 先確認前提成立,不然這條測試會因為「解析器行為改變」而假綠
    expect(url.hostname).toBe('[::ffff:a9fe:a9fe]')
    expect(denied(url.href)).toBe('blocked-host')
  })

  it('URL 解析後的 0.0.0.0 / link-local / multicast 仍然被擋', () => {
    expect(denied(new URL('http://0.0.0.0:8000/v1').href)).toBe('blocked-host')
    expect(denied(new URL('http://169.254.169.254/v1').href)).toBe('blocked-host')
    expect(denied(new URL('http://[fe80::1]/v1').href)).toBe('blocked-host')
  })

  it('URL 解析後的 loopback / Tailscale / Docker 位址仍然通過', () => {
    // 擋掉這三個會直接弄壞「區網自架 AI」這個正常使用方式,必須釘住。
    for (const href of [
      new URL('http://127.0.0.1:8080/v1').href,
      new URL('http://[::1]:8080/v1').href,
      new URL('http://100.101.102.103:11434/v1').href,
      new URL('http://[fd00::1]:8000/v1').href
    ]) {
      expect(normalizeCloudEndpointUrl(href, '/x').ok, href).toBe(true)
    }
  })
})

describe('describeOutboundDenial', () => {
  it('每個拒絕理由都有人話,而且不重複', () => {
    const reasons: OutboundDenyReason[] = ['invalid-url', 'scheme', 'credentials', 'blocked-host']
    const msgs = reasons.map(describeOutboundDenial)
    expect(new Set(msgs).size).toBe(reasons.length)
    for (const m of msgs) {
      expect(m.length).toBeGreaterThan(0)
      expect(m).not.toMatch(/undefined|null|NaN/)
    }
  })
})
