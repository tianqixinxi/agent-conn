import { describe, expect, it } from 'vitest'
import { isBlockedRelayAddress, normalizeRelayOrigin } from '../src/sync/safe-relay-request.js'

describe('safe relay requests', () => {
  it('allows remote HTTPS and loopback HTTP origins only', () => {
    expect(normalizeRelayOrigin('https://connect.meee1.com/')).toBe('https://connect.meee1.com')
    expect(normalizeRelayOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(normalizeRelayOrigin('http://localhost:8787')).toBe('http://localhost:8787')

    expect(() => normalizeRelayOrigin('http://relay.example.com')).toThrow('must use https')
    expect(() => normalizeRelayOrigin('https://10.0.0.1')).toThrow('private or reserved')
    expect(() => normalizeRelayOrigin('https://169.254.169.254')).toThrow('private or reserved')
    expect(() => normalizeRelayOrigin('https://user:pass@relay.example.com')).toThrow('credentials')
    expect(() => normalizeRelayOrigin('https://relay.example.com/proxy')).toThrow('without a path')
    expect(() => normalizeRelayOrigin('file:///tmp/relay')).toThrow('must use https')
  })

  it('blocks private, link-local, loopback, multicast, and IPv4-mapped addresses', () => {
    expect(isBlockedRelayAddress('10.2.3.4', 4)).toBe(true)
    expect(isBlockedRelayAddress('169.254.169.254', 4)).toBe(true)
    expect(isBlockedRelayAddress('127.0.0.1', 4)).toBe(true)
    expect(isBlockedRelayAddress('224.0.0.1', 4)).toBe(true)
    expect(isBlockedRelayAddress('8.8.8.8', 4)).toBe(false)
    expect(isBlockedRelayAddress('fc00::1', 6)).toBe(true)
    expect(isBlockedRelayAddress('fe80::1', 6)).toBe(true)
    expect(isBlockedRelayAddress('::ffff:7f00:1', 6)).toBe(true)
    expect(isBlockedRelayAddress('2606:4700:4700::1111', 6)).toBe(false)
  })
})
