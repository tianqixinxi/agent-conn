import { isAgentCommError } from '@agent-comm/protocol'
import { describe, expect, it } from 'vitest'
import { newE2eKey, open, seal } from '../src/crypto/e2e.js'

function expectAuthFailed(fn: () => void): void {
  let threw = false
  try {
    fn()
  } catch (err) {
    threw = true
    expect(isAgentCommError(err, 'AUTH_FAILED')).toBe(true)
  }
  expect(threw).toBe(true)
}

/**
 * 翻转 base64url 字符串的第一个字符,产出一个确定解出不同字节的值(用于篡改密文/iv)。
 * 不能翻最后一个字符:base64 按 3 字节一组编码成 4 字符,当总字节数 % 3 != 0 时,
 * 最后一组的末位字符会有 2~4 个 bit 是解码时直接丢弃的填充位——只翻这几个 bit 时
 * Buffer.from(…, 'base64url') 解出来的字节可能和原文完全一样,篡改就形同虚设(曾经踩过)。
 * 第一个字符必然落在“整组”里,翻它一定会改变解码出的第一个字节。
 */
function flipFirstChar(s: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const first = s.charAt(0)
  const idx = alphabet.indexOf(first)
  const next = alphabet.charAt((idx + 1) % alphabet.length)
  return next + s.slice(1)
}

describe('crypto/e2e', () => {
  it('newE2eKey 生成 32 字节随机密钥(base64url),每次不同', () => {
    const a = newE2eKey()
    const b = newE2eKey()
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(a).not.toBe(b)
  })

  it('seal/open 往返还原 payload 与 contentType', () => {
    const key = newE2eKey()
    const payload = { text: '简报', n: 42, nested: { ok: true }, list: [1, 2, 3] }
    const sealed = seal(key, payload, 'application/vnd.agentcomm.brief_update+json')
    expect(sealed.enc).toBe('aes-256-gcm')
    expect(sealed.iv.length).toBeGreaterThan(0)
    expect(sealed.ct.length).toBeGreaterThan(0)

    const opened = open(key, sealed)
    expect(opened.payload).toEqual(payload)
    expect(opened.contentType).toBe('application/vnd.agentcomm.brief_update+json')
  })

  it('省略 contentType 时,open 还原为 undefined', () => {
    const key = newE2eKey()
    const sealed = seal(key, { a: 1 })
    const opened = open(key, sealed)
    expect(opened.payload).toEqual({ a: 1 })
    expect(opened.contentType).toBeUndefined()
  })

  it('相同明文每次 seal 产出不同密文(随机 iv,语义安全)', () => {
    const key = newE2eKey()
    const s1 = seal(key, { a: 1 })
    const s2 = seal(key, { a: 1 })
    expect(s1.iv).not.toBe(s2.iv)
    expect(s1.ct).not.toBe(s2.ct)
  })

  it('密文被篡改 → AUTH_FAILED', () => {
    const key = newE2eKey()
    const sealed = seal(key, { secret: 'top' })
    expectAuthFailed(() => open(key, { ...sealed, ct: flipFirstChar(sealed.ct) }))
  })

  it('iv 被篡改 → AUTH_FAILED', () => {
    const key = newE2eKey()
    const sealed = seal(key, { secret: 'top' })
    expectAuthFailed(() => open(key, { ...sealed, iv: flipFirstChar(sealed.iv) }))
  })

  it('密钥不对 → AUTH_FAILED', () => {
    const key = newE2eKey()
    const wrongKey = newE2eKey()
    const sealed = seal(key, { secret: 'top' })
    expectAuthFailed(() => open(wrongKey, sealed))
  })

  it('畸形密文(长度不对)→ AUTH_FAILED,不抛出非 AgentCommError 异常', () => {
    const key = newE2eKey()
    expectAuthFailed(() => open(key, { enc: 'aes-256-gcm', iv: 'AAAA', ct: 'AA' }))
  })
})
