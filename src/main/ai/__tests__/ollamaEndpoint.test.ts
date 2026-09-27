import { describe, it, expect } from 'vitest'
import {
  normalizeOllamaEndpointUrl,
  isBlockedSSRFHost,
  isBlockedSSRFIPv4,
  OLLAMA_DEFAULT_ENDPOINT
} from '../ollamaEndpoint'

describe('normalizeOllamaEndpointUrl', () => {
  it('空值回傳預設 endpoint', () => {
    expect(normalizeOllamaEndpointUrl(undefined)).toBe(OLLAMA_DEFAULT_ENDPOINT)
    expect(normalizeOllamaEndpointUrl('')).toBe(OLLAMA_DEFAULT_ENDPOINT)
    expect(normalizeOllamaEndpointUrl(null)).toBe(OLLAMA_DEFAULT_ENDPOINT)
  })

  it('origin 補 /api/chat;/api/chat 原樣;/api 結尾補 /chat', () => {
    expect(normalizeOllamaEndpointUrl('http://localhost:11434')).toBe('http://localhost:11434/api/chat')
    expect(normalizeOllamaEndpointUrl('http://localhost:11434/api/chat')).toBe('http://localhost:11434/api/chat')
    expect(normalizeOllamaEndpointUrl('http://localhost:11434/api/')).toBe('http://localhost:11434/api/chat')
  })

  it('私網與 loopback 允許', () => {
    expect(normalizeOllamaEndpointUrl('http://10.0.0.5:11434')).toBe('http://10.0.0.5:11434/api/chat')
    expect(normalizeOllamaEndpointUrl('http://192.168.1.20:11434')).toBe('http://192.168.1.20:11434/api/chat')
    expect(normalizeOllamaEndpointUrl('http://172.16.0.1:11434')).toBe('http://172.16.0.1:11434/api/chat')
    expect(normalizeOllamaEndpointUrl('http://[::1]:11434')).toBe('http://[::1]:11434/api/chat')
  })

  it('非法 URL / 非.http(s) 協定回 null', () => {
    expect(normalizeOllamaEndpointUrl('not a url')).toBeNull()
    expect(normalizeOllamaEndpointUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeOllamaEndpointUrl('ftp://localhost:11434')).toBeNull()
  })

  it('SSRF 目標回 null(metadata / link-local / CGNAT / multicast / reserved / 公網)', () => {
    expect(normalizeOllamaEndpointUrl('http://169.254.169.254/api/chat')).toBeNull()
    expect(normalizeOllamaEndpointUrl('http://100.64.0.1:11434')).toBeNull()
    expect(normalizeOllamaEndpointUrl('http://224.0.0.1:11434')).toBeNull()
    expect(normalizeOllamaEndpointUrl('http://240.0.0.1:11434')).toBeNull()
    expect(normalizeOllamaEndpointUrl('http://0.0.0.0:11434')).toBeNull()
    expect(normalizeOllamaEndpointUrl('http://8.8.8.8:11434')).toBeNull()
    expect(normalizeOllamaEndpointUrl('http://metadata.google.internal/api/chat')).toBeNull()
  })
})

describe('isBlockedSSRFHost (IPv6)', () => {
  it('未指定 / unique-local / link-local 為真', () => {
    expect(isBlockedSSRFHost('::')).toBe(true)
    expect(isBlockedSSRFHost('::0')).toBe(true)
    expect(isBlockedSSRFHost('fc00::1')).toBe(true)
    expect(isBlockedSSRFHost('fd12:3456::1')).toBe(true)
    expect(isBlockedSSRFHost('fe80::1')).toBe(true)
  })

  it('IPv4-mapped:內嵌被阻擋 IP 為真,loopback 為假', () => {
    expect(isBlockedSSRFHost('::ffff:169.254.1.1')).toBe(true)
    expect(isBlockedSSRFHost('::ffff:127.0.0.1')).toBe(false)
  })

  it('正常 loopback / 私網為假', () => {
    expect(isBlockedSSRFHost('localhost')).toBe(false)
    expect(isBlockedSSRFHost('127.0.0.1')).toBe(false)
    expect(isBlockedSSRFHost('10.1.2.3')).toBe(false)
    expect(isBlockedSSRFHost('::1')).toBe(false)
  })
})

describe('isBlockedSSRFIPv4', () => {
  it('非法格式回 false(不擋)', () => {
    expect(isBlockedSSRFIPv4('abc')).toBe(false)
    expect(isBlockedSSRFIPv4('1.2.3')).toBe(false)
    expect(isBlockedSSRFIPv4('1.2.3.256')).toBe(false)
  })

  it('172.16-31 私網不擋(此函數只管特殊網段;公網 172.32 由正規化層的私網白名單擋)', () => {
    expect(isBlockedSSRFIPv4('172.16.0.1')).toBe(false)
    expect(isBlockedSSRFIPv4('172.31.255.255')).toBe(false)
    expect(isBlockedSSRFIPv4('172.32.0.1')).toBe(false) // 公網普通位址,非特殊網段
    expect(normalizeOllamaEndpointUrl('http://172.32.0.1:11434')).toBeNull() // 但正規化會擋
  })
})
